import { Inject, Injectable } from '@nestjs/common';
import {
  KafkaContext,
  KafkaCtx,
  KafkaHeaders,
  KafkaMessage,
  KafkaConsumer,
  KafkaHandler,
} from '@nest-native/kafka';
import { loadEnv } from '../../config/env';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  isUserInvitedPayload,
  OUTBOX_TOPIC_USER_INVITED,
  type UserInvitedPayload,
} from '../outbox/outbox.constants';
import type { WireHeaderValue } from '../outbox/wire-contract';
import { KafkaInbox } from './kafka-inbox';
import { userInvitedDelivered } from './user-invited.delivery';

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
// The inbox's consumer name scopes its records to this topic+group, so the same
// message consumed by a different group/topic does not collide in the shared
// inbox table.
const CONSUMER = `${TOPIC}:${GROUP_ID}`;

/**
 * Kafka consumer for the `user.invited` topic — the consumer half of the
 * reliable-messaging pair. It is a thin `@KafkaConsumer` shell over the app's
 * {@link KafkaInbox} engine: it owns the static topic + group + DLQ and supplies
 * the concrete payload validator and the exactly-once side effect (a
 * synchronous audit-log write), while the engine runs the async broker work
 * (the dead-letter copy) OUTSIDE the dedup transaction and the official
 * inbox's `processInTransaction()` INSIDE it.
 *
 * Delivery semantics are owned by the engine: happy path / duplicate → return
 * (offset commits); poison message (bad key / invalid payload) → dead-lettered
 * to {@link DLQ_TOPIC} then return; transient failure → throw (broker redelivers).
 */
@Injectable()
@KafkaConsumer(TOPIC, { groupId: GROUP_ID })
export class UserInvitedConsumer {
  constructor(
    @Inject(KafkaInbox) private readonly inbox: KafkaInbox,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
  ) {}

  @KafkaHandler()
  async handle(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.inbox.consume<UserInvitedPayload>({
      consumer: CONSUMER,
      context,
      headers,
      payload,
      validate: isUserInvitedPayload,
      // Synchronous, DB-only side effect (required by the sqlite sync tx): write
      // the delivery audit row. A throw inside rolls back the inbox record too.
      sideEffect: (invite) => {
        this.audit.record(userInvitedDelivered(invite));
      },
      dlqTopic: DLQ_TOPIC,
    });
  }
}
