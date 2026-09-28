import type { Channel } from 'amqplib';
import {
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
  OUTBOX_TOPIC_USER_INVITED,
} from '../outbox/outbox.constants';

/** DI token for the application's RabbitMQ connection. */
export const RABBITMQ = Symbol.for('reference-app:rabbitmq');

/** A queue the app consumes, the outbox topics bound to it, and where its dead letters go. */
export interface ConsumedQueue {
  name: string;
  topics: readonly string[];
  deadLetterQueue: string;
}

/**
 * Invites get a queue of their own: one consumer, one side effect.
 */
export const USER_INVITED_QUEUE: ConsumedQueue = {
  name: 'reference-app.user-invited',
  topics: [OUTBOX_TOPIC_USER_INVITED],
  deadLetterQueue: 'reference-app.user-invited.dead',
};

/**
 * One work queue for the whole task lifecycle — three bindings, one consumer,
 * which picks the projection by routing key. A topic exchange makes that a
 * declaration rather than code; the Kafka profile needs a handler per topic.
 */
export const TASK_ACTIVITY_QUEUE: ConsumedQueue = {
  name: 'reference-app.task-activity',
  topics: [
    OUTBOX_TOPIC_TASK_CREATED,
    OUTBOX_TOPIC_TASK_ASSIGNED,
    OUTBOX_TOPIC_TASK_COMPLETED,
  ],
  deadLetterQueue: 'reference-app.task-activity.dead',
};

export const CONSUMED_QUEUES = [USER_INVITED_QUEUE, TASK_ACTIVITY_QUEUE] as const;

/** The exchange dead letters are published to, next to the events exchange. */
export function deadLetterExchange(eventsExchange: string): string {
  return `${eventsExchange}.dead-letters`;
}

/**
 * Declares everything the app publishes to and consumes from. The app owns its
 * topology — the outbox transport and the inbox never declare anything — so it
 * runs at startup, idempotently, the way migrations create tables.
 *
 * Every queue is a durable quorum queue: RabbitMQ 4 refuses a transient shared
 * queue by closing the whole connection. A quorum queue's delivery limit (20 by
 * default) counts a message that went back to the queue with a closing channel
 * — one that crashes its consumer every time — not the inbox's own requeues of
 * a transient failure, which its backoff paces. A message past the limit is
 * dead-lettered with the queue's name as its routing key — without an explicit
 * key it would keep its original one, miss the dead-letter queue's binding, and
 * be dropped.
 */
export async function declareTopology(
  channel: Channel,
  eventsExchange: string,
): Promise<void> {
  const deadLetters = deadLetterExchange(eventsExchange);
  await channel.assertExchange(eventsExchange, 'topic', { durable: true });
  await channel.assertExchange(deadLetters, 'topic', { durable: true });
  for (const queue of CONSUMED_QUEUES) {
    await channel.assertQueue(queue.name, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': deadLetters,
        'x-dead-letter-routing-key': queue.name,
      },
    });
    for (const topic of queue.topics) {
      await channel.bindQueue(queue.name, eventsExchange, topic);
    }
    await channel.assertQueue(queue.deadLetterQueue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.bindQueue(queue.deadLetterQueue, deadLetters, queue.name);
  }
}
