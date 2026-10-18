import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { type KafkaContext, KafkaProducerService } from '@nest-native/kafka';
import {
  NonRetryableMessageError,
  OutboxInbox,
  type OutboxInboxResult,
} from '@nestjs/outbox';
import type { AppDatabase } from '../../database/database';
import {
  deriveDedupKey,
  type WireHeaderValue,
  X_ERROR,
} from '../outbox/wire-contract';

/** What a delivery came to, for logging; a transient failure throws instead. */
export interface KafkaConsumeResult {
  outcome: 'processed' | 'duplicate' | 'dead-lettered';
  dedupKey?: string;
}

export interface KafkaConsumeOptions<T> {
  /**
   * The inbox's consumer name: whose deliveries the inbox records (typically
   * `topic:groupId`). Keep it stable, or every past message looks new.
   */
  consumer: string;
  /** The Kafka context, for the message key and the dead-letter copy. */
  context: KafkaContext;
  headers: Record<string, WireHeaderValue> | undefined;
  /** The deserialized payload, narrowed by `validate`. */
  payload: unknown;
  /** A payload it rejects is poison: dead-lettered, never retried. */
  validate: (payload: unknown) => payload is T;
  /**
   * The exactly-once side effect: it runs only for a delivery the inbox has
   * not seen, in the transaction that records it. Synchronous and DB-only, as
   * a better-sqlite3 transaction has to be.
   */
  sideEffect: (payload: T, dedupKey: string) => void;
  /** Where poison is republished, with its reason in `x-error`, before the offset commits. */
  dlqTopic: string;
}

/**
 * The idempotent-consumer engine behind the app's `@KafkaConsumer` shells,
 * on the official inbox: the dedup key comes from the wire contract, and
 * `OutboxInbox.processInTransaction()` records the delivery and runs the side
 * effect in one transaction, so a redelivery (or a duplicate a retried publish
 * sent) finds the record and skips the work.
 *
 * - processed or duplicate: returns, and `@nest-native/kafka` commits the
 *   offset;
 * - no dedup key, or a payload `validate` rejects: republished to `dlqTopic`
 *   and returns, so poison is not redelivered forever;
 * - anything else: throws, the offset stays, and the broker redelivers.
 *
 * Ported from `@nest-native/messaging/kafka`'s `KafkaInboxConsumer`; only the
 * inbox it records into changed.
 */
@Injectable()
export class KafkaInbox {
  private readonly logger = new Logger(KafkaInbox.name);

  constructor(
    @Inject(OutboxInbox) private readonly inbox: OutboxInbox,
    @Inject(KafkaProducerService)
    private readonly producer: KafkaProducerService,
    @InjectTransaction() private readonly db: AppDatabase,
  ) {}

  async consume<T>(options: KafkaConsumeOptions<T>): Promise<KafkaConsumeResult> {
    try {
      const dedupKey = deriveDedupKey(options.headers, keyOf(options.context));
      const { payload } = options;
      if (!options.validate(payload)) {
        throw new NonRetryableMessageError('payload failed validation');
      }
      const { duplicate } = await this.record(options.consumer, dedupKey, () =>
        options.sideEffect(payload, dedupKey),
      );
      if (duplicate) {
        this.logger.debug(`duplicate skipped: ${dedupKey}`);
      }
      return { outcome: duplicate ? 'duplicate' : 'processed', dedupKey };
    } catch (error) {
      if (error instanceof NonRetryableMessageError) {
        await this.deadLetter(options.context, options.dlqTopic, error);
        return { outcome: 'dead-lettered' };
      }
      throw error;
    }
  }

  // The inbox record and the side effect's writes commit together, or neither
  // does. On better-sqlite3 the body runs synchronously; @Transactional() hands
  // the caller a Promise of its result.
  @Transactional()
  private record(
    consumer: string,
    dedupKey: string,
    work: () => void,
  ): Promise<OutboxInboxResult<void>> {
    return this.inbox.processInTransaction(
      this.db,
      consumer,
      dedupKey,
      work,
    ) as Promise<OutboxInboxResult<void>>;
  }

  private async deadLetter(
    context: KafkaContext,
    dlqTopic: string,
    error: NonRetryableMessageError,
  ): Promise<void> {
    this.logger.warn(`dead-lettered to ${dlqTopic}: ${error.message}`);
    const original = context.getMessage();
    await this.producer.send({
      topic: dlqTopic,
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

function keyOf(context: KafkaContext): string | undefined {
  const key = context.getMessage().key;
  if (typeof key === 'string') return key;
  return Buffer.isBuffer(key) ? key.toString('utf8') : undefined;
}
