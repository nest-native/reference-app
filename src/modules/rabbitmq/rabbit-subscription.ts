import type { Logger } from '@nestjs/common';
import type { RabbitInboxConsumer } from '@nest-native/messaging/rabbitmq';
import type {
  Channel,
  ConfirmChannel,
  ConsumeMessage,
  RecoveringChannelModel,
} from 'amqplib';
import type { ConsumedQueue } from './rabbitmq.topology';

/** What a subscriber does with one delivery, given the channels it arrived on. */
export type DeliveryHandler = (
  message: ConsumeMessage,
  channels: { channel: Channel; deadLetterChannel: ConfirmChannel },
) => Promise<void>;

/** A queue the app keeps consuming until it shuts down. */
export interface Subscription {
  /**
   * Stops subscribing again. Call it in `beforeApplicationShutdown`: the
   * connection closes in `onApplicationShutdown`, and its channels closing
   * would otherwise look like a failure to recover from.
   */
  stop(): void;
}

const PREFETCH = 10;
/** The pause before subscribing again, so a queue that is gone is not a hot loop. */
const RESUBSCRIBE_DELAY_MS = 1_000;

/**
 * Subscribes a queue with manual acks and a prefetch, for as long as the app
 * runs. Dead letters go out on a separate confirm channel, so a poison message
 * is stored before its delivery is acked.
 *
 * The channels can go away under the consumer: the connection drops (amqplib's
 * recovering connection comes back after a broker restart, its channels do
 * not), the broker closes a channel (an ack timeout, an access error), or it
 * cancels the consumer (the queue was deleted). Every one of those ends with a
 * channel closing, so this subscribes again, on new channels, whenever one
 * closes — `createChannel()` waits while the connection is recovering.
 * Subscribing again only on the connection's `connect` event would miss the
 * last two: the connection stays up, and the consumer would stop without a
 * trace.
 */
export async function subscribe(
  rabbit: RecoveringChannelModel,
  queue: ConsumedQueue,
  handle: DeliveryHandler,
  logger: Logger,
): Promise<Subscription> {
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;

  const resubscribe = (): void => {
    if (stopped || retry) {
      return;
    }
    retry = setTimeout(() => {
      retry = undefined;
      if (stopped) {
        return;
      }
      open().catch((error: unknown) => {
        logger.error(`${queue.name}: could not subscribe: ${String(error)}`);
        resubscribe();
      });
    }, RESUBSCRIBE_DELAY_MS);
  };

  const open = async (): Promise<void> => {
    const opened: Channel[] = [];
    const watch = async <C extends Channel>(opening: Promise<C>): Promise<C> => {
      const channel = await opening;
      opened.push(channel);
      // The broker's reason for closing a channel arrives as 'error', and an
      // EventEmitter with no 'error' listener throws it, crashing the process.
      channel.on('error', (error: Error) =>
        logger.warn(`${queue.name}: channel closed by the broker: ${error.message}`),
      );
      // Either channel closing ends this subscription: close the other one
      // and start over.
      channel.once('close', () => {
        for (const each of opened) {
          each.close().catch(() => undefined);
        }
        resubscribe();
      });
      return channel;
    };
    const channel = await watch(rabbit.createChannel());
    const deadLetterChannel = await watch(rabbit.createConfirmChannel());
    await channel.prefetch(PREFETCH);
    await channel.consume(queue.name, (message) => {
      if (!message) {
        // The broker cancelled the consumer; closing the channel starts over.
        channel.close().catch(() => undefined);
        return;
      }
      handle(message, { channel, deadLetterChannel }).catch((error: unknown) =>
        logger.error(`${queue.name}: delivery failed: ${String(error)}`),
      );
    });
  };

  const stop = (): void => {
    stopped = true;
    clearTimeout(retry);
  };

  try {
    await open();
  } catch (error) {
    stop(); // a queue the app cannot consume at startup fails the boot instead
    throw error;
  }
  return { stop };
}

export type { RabbitInboxConsumer };
