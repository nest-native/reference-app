import {
  deriveDedupKey as deriveWireKey,
  type WireHeaderValue,
} from '../../messaging/wire-contract';
import {
  PermanentError,
  RetryableError,
} from '../outbox/outbox-transport';
import type { RunOnceOutcome } from './inbox.service';

// Consumer-side reuse of the producer/inbox error vocabulary: a PermanentError
// is unrecoverable (route to the dead-letter topic and ack so it stops
// redelivering); anything else is retryable (throw so the broker redelivers).
export { PermanentError, RetryableError } from '../outbox/outbox-transport';

/**
 * Derive the dedup key for an incoming message, enforcing the inbox's contract
 * that a message MUST be keyable. Applies the shared wire-contract order
 * (`x-event-id` → `x-idempotency-key` → Kafka key); a message with none of them
 * cannot be deduplicated, so it is a {@link PermanentError} → dead-letter rather
 * than an endless redelivery.
 */
export function deriveDedupKey(
  headers: Record<string, WireHeaderValue> | undefined,
  kafkaKey: string | undefined,
): string {
  const key = deriveWireKey(headers, kafkaKey);
  if (!key) {
    throw new PermanentError(
      'message has no x-event-id, x-idempotency-key, or key — cannot deduplicate',
    );
  }
  return key;
}

/**
 * What the consumer wrapper should do with a message after `runOnce`. Mapped to
 * the broker's at-least-once primitives: `ack` commits the offset (done),
 * `redeliver` leaves it uncommitted (the broker retries), `dead-letter`
 * publishes to the DLQ topic then acks.
 */
export type ConsumerAction = 'ack' | 'redeliver' | 'dead-letter';

/**
 * Map a successful {@link RunOnceOutcome} to a consumer action. Both a freshly
 * processed message and a duplicate are acked — the work is durably done (or was
 * already done), so the offset should advance in both cases.
 */
export function actionForOutcome(_outcome: RunOnceOutcome): ConsumerAction {
  return 'ack';
}

/**
 * Map a thrown error to a consumer action: a {@link PermanentError} is
 * dead-lettered (retrying can never succeed), anything else is redelivered.
 */
export function actionForError(error: unknown): ConsumerAction {
  return error instanceof PermanentError ? 'dead-letter' : 'redeliver';
}
