import { Inject, Injectable } from '@nestjs/common';
import { OutboxRegistry } from './outbox-registry.service';
import {
  type OutboxMessage,
  type OutboxTransport,
  PermanentError,
  RetryableError,
} from './outbox-transport';

/**
 * The default transport: dispatch the event to its in-process handler via the
 * {@link OutboxRegistry}. This preserves the app's pre-Kafka behaviour exactly —
 * a missing handler is a permanent failure (the claimer marks the row failed),
 * a `{ retryAfterMs }` result is a retry, and `'completed'` resolves.
 *
 * No Kafka, no network: with the Kafka profile off this is the only transport
 * wired, so every existing outbox test exercises this path unchanged.
 */
@Injectable()
export class InProcessOutboxTransport implements OutboxTransport {
  constructor(
    @Inject(OutboxRegistry) private readonly registry: OutboxRegistry,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const handler = this.registry.get(message.topic);
    if (!handler) {
      // Matches the legacy claimer: an unroutable event can never succeed, so
      // fail it now instead of retrying.
      throw new PermanentError(
        `no handler registered for topic "${message.topic}"`,
      );
    }

    const result = await handler(message.payload);
    if (result === 'completed') return;
    throw new RetryableError(
      `handler for "${message.topic}" requested retry`,
      result.retryAfterMs,
    );
  }
}
