import type { KafkaProducerService } from '@nest-native/kafka';
import { type OutboxMessage, OutboxTransport } from '@nestjs/outbox';
import {
  encodeWireValue,
  X_EVENT_ID,
  X_IDEMPOTENCY_KEY,
} from './wire-contract';

/**
 * The official outbox's Kafka transport, over `@nest-native/kafka`'s producer:
 * the relay hands it each message to publish, and resolving means the broker
 * took it. It writes the wire the consumers dedupe on: the message key and
 * `x-idempotency-key` are the business key (the id when there is none),
 * `x-event-id` is the message id, and the value is the JSON payload.
 *
 * A send that throws counts as a failed attempt, which the relay retries with
 * backoff. Delivery is at-least-once, and the consumers' inbox drops what
 * arrives twice.
 */
export class KafkaOutboxTransport extends OutboxTransport {
  constructor(
    private readonly producer: KafkaProducerService,
    private readonly topicPrefix = '',
  ) {
    super();
  }

  async publish(
    message: OutboxMessage,
    { signal }: { signal: AbortSignal },
  ): Promise<void> {
    // A produce cannot be called back. Past publishTimeout the relay counts the
    // attempt failed; if the send lands anyway, its retry is a duplicate.
    signal.throwIfAborted();
    const key = message.headers[X_IDEMPOTENCY_KEY] ?? message.id;
    await this.producer.send({
      topic: `${this.topicPrefix}${message.topic}`,
      messages: [
        {
          key,
          value: encodeWireValue(message.payload),
          headers: {
            ...message.headers,
            [X_EVENT_ID]: message.id,
            [X_IDEMPOTENCY_KEY]: key,
          },
        },
      ],
    });
  }
}
