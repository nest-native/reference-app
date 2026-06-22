import type { KafkaProducerService } from '@nest-native/kafka';
import {
  encodeWireValue,
  X_EVENT_ID,
  X_IDEMPOTENCY_KEY,
} from '../../messaging/wire-contract';
import type { OutboxMessage, OutboxTransport } from './outbox-transport';

/**
 * The opt-in transport: publish the outbox event to Kafka. This is the ONLY
 * producer-side file that imports `@nest-native/kafka`, so the Kafka dependency
 * stays isolated to the seam and the rest of the outbox is broker-agnostic.
 *
 * The transactional-outbox guarantee is: the row was committed in the same DB
 * transaction as the business write, and the claimer publishes it here exactly
 * once it observes it. A `send` that throws (broker down, timeout) propagates so
 * the claimer retries the row — at-least-once delivery, which the consumer-side
 * inbox deduplicates.
 */
export class KafkaOutboxTransport implements OutboxTransport {
  constructor(
    private readonly producer: KafkaProducerService,
    private readonly topicPrefix: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const key = message.idempotencyKey ?? message.id;
    await this.producer.send({
      topic: `${this.topicPrefix}${message.topic}`,
      messages: [
        {
          key,
          value: encodeWireValue(message.payload),
          headers: {
            [X_EVENT_ID]: message.id,
            [X_IDEMPOTENCY_KEY]: key,
          },
        },
      ],
    });
    // Resolve on success. A send failure throws here and the claimer retries.
  }
}
