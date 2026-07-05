import { Inject, Injectable } from '@nestjs/common';
import {
  KafkaContext,
  KafkaCtx,
  KafkaHeaders,
  KafkaMessage,
  KafkaConsumer,
  KafkaHandler,
} from '@nest-native/kafka';
import { type WireHeaderValue } from '@nest-native/messaging';
import { KafkaInboxConsumer } from '@nest-native/messaging/kafka';
import { loadEnv } from '../../config/env';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  isUserInvitedPayload,
  OUTBOX_TOPIC_USER_INVITED,
  type UserInvitedPayload,
} from '../outbox/outbox.constants';

// The topic/group/prefix are resolved from env at class-definition time because
// `@KafkaConsumer` takes a static topic. `loadEnv()` is a pure env read and is
// safe to call always; this consumer is only *registered* (and only runs) under
// the Kafka profile, as a provider of UserInvitedInboxModule (the transport's
// explorer discovers @KafkaConsumer providers in any module).
const kafkaEnv = loadEnv().kafka;
const TOPIC_PREFIX = kafkaEnv?.topicPrefix ?? '';
const GROUP_ID = kafkaEnv?.groupId ?? 'reference-app';
const TOPIC = `${TOPIC_PREFIX}${OUTBOX_TOPIC_USER_INVITED}`;
const DLQ_TOPIC = `${TOPIC}.DLQ`;
// `source` scopes dedup keys to this topic+group so the same key consumed by a
// different group/topic does not collide in the shared inbox table.
const SOURCE = `${TOPIC}:${GROUP_ID}`;

/**
 * Kafka consumer for the `user.invited` topic — the consumer half of the
 * reliable-messaging pair. This is now a thin `@KafkaConsumer` shell over the
 * library's {@link KafkaInboxConsumer} engine: it owns the static topic + group +
 * DLQ and supplies the concrete payload validator and the exactly-once side
 * effect (a synchronous audit-log write), while the engine runs all async broker
 * work (parse, ack, dead-letter) OUTSIDE the dedup transaction and the
 * `InboxService.runOnce` primitive INSIDE it.
 *
 * Delivery semantics are owned by the engine: happy path / duplicate → return
 * (offset commits); poison message (bad key / invalid payload) → dead-lettered
 * to {@link DLQ_TOPIC} then return; transient failure → throw (broker redelivers).
 */
@Injectable()
@KafkaConsumer(TOPIC, { groupId: GROUP_ID })
export class UserInvitedConsumer {
  constructor(
    @Inject(KafkaInboxConsumer) private readonly inbox: KafkaInboxConsumer,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
  ) {}

  @KafkaHandler()
  async handle(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.inbox.consume<UserInvitedPayload>({
      source: SOURCE,
      context,
      headers,
      payload,
      validate: isUserInvitedPayload,
      // Synchronous, DB-only side effect (required by the sqlite sync tx): write
      // the delivery audit row. A throw inside rolls back the dedup row too.
      sideEffect: (invite) => {
        this.audit.record({
          orgId: invite.orgId,
          actorUserId: invite.invitedByUserId,
          action: 'user.invited.delivered',
          subjectType: 'user',
          subjectId: String(invite.invitedUserId),
          metadata: {
            invitedEmail: invite.invitedEmail,
            projectId: invite.projectId,
          },
        });
      },
      dlqTopic: DLQ_TOPIC,
    });
  }
}
