import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  KafkaContext,
  KafkaCtx,
  KafkaHeaders,
  KafkaMessage,
  KafkaConsumer,
  KafkaHandler,
  KafkaProducerService,
} from '@nest-native/kafka';
import { loadEnv } from '../../config/env';
import {
  encodeWireValue,
  X_ERROR,
  type WireHeaderValue,
} from '../../messaging/wire-contract';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  isUserInvitedPayload,
  OUTBOX_TOPIC_USER_INVITED,
} from '../outbox/outbox.constants';
import {
  deriveDedupKey,
  PermanentError,
} from './idempotent-consumer';
import { InboxService } from './inbox.service';

// The topic/group/prefix are resolved from env at class-definition time because
// `@KafkaConsumer` takes a static topic. `loadEnv()` is a pure env read and is
// safe to call always; this consumer is only *registered* (and only runs) under
// the Kafka profile, via InboxModule.forRootAsync + KafkaModule.forFeature.
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
 * reliable-messaging pair.
 *
 * The wrapper does all async broker work (parse, validate, ack, DLQ publish)
 * OUTSIDE the dedup transaction; the only thing it runs inside the transaction
 * is the synchronous {@link InboxService.runOnce} primitive. Delivery semantics:
 *
 *   - happy path / duplicate → `runOnce` returns, the handler returns, the
 *     offset auto-commits (`@nest-native/kafka` commits when the handler returns).
 *   - bad key / malformed payload ({@link PermanentError}) → publish to the DLQ
 *     topic with an `x-error` header, then RETURN so the offset commits (no
 *     endless redelivery of a poison message).
 *   - transient failure (anything else, e.g. the audit write fails) → THROW so
 *     the offset is NOT committed and the broker redelivers.
 *
 * The observable side effect is a synchronous audit-log row written in the same
 * transaction as the dedup row, so atomicity (and dedup) is provable in the DB.
 */
@Injectable()
@KafkaConsumer(TOPIC, { groupId: GROUP_ID })
export class UserInvitedConsumer {
  private readonly logger = new Logger(UserInvitedConsumer.name);

  constructor(
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
    @Inject(KafkaProducerService)
    private readonly producer: KafkaProducerService,
  ) {}

  @KafkaHandler()
  async handle(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    const kafkaKey = this.readKey(context);
    try {
      const dedupKey = deriveDedupKey(headers, kafkaKey);
      if (!isUserInvitedPayload(payload)) {
        throw new PermanentError('user.invited: malformed payload');
      }
      // The side effect is synchronous (required by the sync transaction): write
      // the delivery audit row. A throw inside rolls back the dedup row too.
      const outcome = await this.inbox.runOnce(dedupKey, SOURCE, () => {
        this.audit.record({
          orgId: payload.orgId,
          actorUserId: payload.invitedByUserId,
          action: 'user.invited.delivered',
          subjectType: 'user',
          subjectId: String(payload.invitedUserId),
          metadata: {
            invitedEmail: payload.invitedEmail,
            projectId: payload.projectId,
            dedupKey,
          },
        });
      });
      if (outcome === 'duplicate') {
        this.logger.debug(`user.invited duplicate skipped: ${dedupKey}`);
      }
      // Return → offset commits (the message is durably processed or was a dup).
    } catch (error) {
      if (error instanceof PermanentError) {
        // Poison message: dead-letter it and ack so it stops redelivering.
        await this.deadLetter(context, error);
        return;
      }
      // Transient: rethrow so the offset is not committed → broker redelivers.
      throw error;
    }
  }

  private readKey(context: KafkaContext): string | undefined {
    const key = context.getMessage().key;
    if (key === null || key === undefined) return undefined;
    return Buffer.isBuffer(key) ? key.toString('utf8') : key;
  }

  private async deadLetter(
    context: KafkaContext,
    error: PermanentError,
  ): Promise<void> {
    this.logger.warn(
      `user.invited dead-lettered to ${DLQ_TOPIC}: ${error.message}`,
    );
    const original = context.getMessage();
    await this.producer.send({
      topic: DLQ_TOPIC,
      messages: [
        {
          key: original.key ?? null,
          value: original.value,
          headers: { [X_ERROR]: error.message },
        },
      ],
    });
  }
}
