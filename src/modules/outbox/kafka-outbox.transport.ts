import type { KafkaProducerService } from '@nest-native/kafka';
import {
  type KafkaOutboxRecord,
  KafkaOutboxTransport,
} from '@nest-native/kafka/outbox';
import type { OutboxMessage } from '@nestjs/outbox';
import {
  encodeWireValue,
  wireHeaders,
  X_IDEMPOTENCY_KEY,
} from './wire-contract';

/**
 * The official outbox's Kafka transport: `@nest-native/kafka`'s own
 * `KafkaOutboxTransport`, over its producer, writing this app's wire in place
 * of the official transport's record. The relay hands it each message to
 * publish, and resolving means the broker took it.
 *
 * A send that throws counts as a failed attempt, which the relay retries with
 * backoff, except a failure no retry can fix (a record too large for the
 * topic, a topic the app may not write to), which the relay dead-letters at
 * once. Delivery is at-least-once, and the consumers' inbox drops what arrives
 * twice.
 */
export function createKafkaOutboxTransport(
  producer: KafkaProducerService,
  topicPrefix = '',
): KafkaOutboxTransport {
  return new KafkaOutboxTransport(producer, {
    toRecord: (message) => toWireRecord(message, topicPrefix),
  });
}

/**
 * The record the consumers dedupe on: the message key and `x-idempotency-key`
 * are the business key (the id when there is none), `x-event-id` is the
 * message id, and the value is the JSON payload rather than the official
 * envelope.
 */
function toWireRecord(
  message: OutboxMessage,
  topicPrefix: string,
): KafkaOutboxRecord {
  const headers = wireHeaders(message);
  return {
    topic: `${topicPrefix}${message.topic}`,
    key: headers[X_IDEMPOTENCY_KEY],
    value: encodeWireValue(message.payload),
    headers,
  };
}
