import { NonRetryableMessageError } from '@nestjs/outbox';

// The wire contract the app's broker transports and consumers share: the
// header names, the order a dedup key is derived in, and the JSON body codec,
// in one place so the two halves cannot drift apart. It is byte for byte the
// format @nest-native/messaging put on the wire, so a consumer of these topics
// sees no change.

/**
 * The outbox message id. A consumer's first choice of dedup key: it is the id
 * the official inbox records, and it stays the same across redeliveries.
 */
export const X_EVENT_ID = 'x-event-id' as const;

/**
 * The business idempotency key (e.g. `user.invited:<org>:<user>:<project>`):
 * the dedup key when a message has no event id, and the Kafka message key.
 */
export const X_IDEMPOTENCY_KEY = 'x-idempotency-key' as const;

/** Why a message was dead-lettered, on the copy a consumer sends to the dead letters. */
export const X_ERROR = 'x-error' as const;

/**
 * A header value as a broker client delivers it: a string, a Buffer, an array
 * of either, or undefined when the header is absent.
 */
export type WireHeaderValue =
  | string
  | Buffer
  | (string | Buffer)[]
  | undefined;

/** A header value as a string: brokers deliver them as Buffers, or arrays of them. */
export function headerToString(value: WireHeaderValue): string | undefined {
  if (Array.isArray(value)) return headerToString(value[0]);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
}

/**
 * The dedup key of a delivered message, in the contract's order: `x-event-id`,
 * then `x-idempotency-key`, then the broker's message key. A message with none
 * of them cannot be deduplicated, so it is poison: dead-lettered, not retried.
 */
export function deriveDedupKey(
  headers: Record<string, WireHeaderValue> | undefined,
  brokerKey: string | undefined,
): string {
  const key =
    headerToString(headers?.[X_EVENT_ID]) ||
    headerToString(headers?.[X_IDEMPOTENCY_KEY]) ||
    brokerKey;
  if (!key) {
    throw new NonRetryableMessageError(
      'message has no x-event-id, x-idempotency-key, or key — cannot deduplicate',
    );
  }
  return key;
}

/** A payload as a message value: brokers do not encode values themselves. */
export function encodeWireValue(payload: unknown): string {
  return JSON.stringify(payload);
}

/** A message value back to its payload; the caller narrows it with a guard. */
export function decodeWireValue(value: string | Buffer | null): unknown {
  if (value === null) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  return JSON.parse(text);
}
