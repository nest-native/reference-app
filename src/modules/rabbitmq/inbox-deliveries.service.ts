import { Injectable, Logger } from '@nestjs/common';
import type { RabbitConsumeResult } from '@nest-native/messaging/rabbitmq';

/** One settled delivery: the queue it came from and what the inbox did with it. */
export interface InboxDelivery extends RabbitConsumeResult {
  queue: string;
}

type Listener = (delivery: InboxDelivery) => void;

/**
 * Where the RabbitMQ consumers report what the inbox did with each delivery —
 * processed, duplicate, dead-lettered or requeued. It logs every one (the inbox
 * itself already warns on dead letters and requeues) and hands it to any
 * listener: this is the seam for metrics, and the gated e2e listens here to
 * know a redelivery was recognised rather than guessing with a sleep.
 */
@Injectable()
export class InboxDeliveries {
  private readonly logger = new Logger('RabbitInbox');
  private readonly listeners = new Set<Listener>();

  record(delivery: InboxDelivery): void {
    this.logger.debug(
      `${delivery.queue}: ${delivery.outcome}${delivery.dedupKey ? ` (${delivery.dedupKey})` : ''}`,
    );
    for (const listener of this.listeners) {
      listener(delivery);
    }
  }

  /** Subscribe to every settled delivery; returns the unsubscribe function. */
  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
