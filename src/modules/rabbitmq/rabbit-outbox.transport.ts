import { type OutboxMessage, OutboxTransport } from '@nestjs/outbox';
import type { ConfirmChannel, Message } from 'amqplib';
import {
  encodeWireValue,
  X_EVENT_ID,
  X_IDEMPOTENCY_KEY,
} from '../outbox/wire-contract';

/**
 * Anything that opens confirm channels: amqplib's `ChannelModel` from
 * `connect(url)`, or the `RecoveringChannelModel` from
 * `connect(url, { recovery: true })`. The application owns the connection;
 * the transport only opens (and reopens) its own confirm channel on it.
 */
export interface RabbitConfirmChannelSource {
  createConfirmChannel(): Promise<ConfirmChannel>;
}

export interface RabbitOutboxTransportOptions {
  /** The connection the transport opens its confirm channel on. */
  connection: RabbitConfirmChannelSource;
  /**
   * The exchange every outbox message is published to. The message's topic is
   * the routing key, so a `topic` exchange lets consumers bind by pattern.
   */
  exchange: string;
}

/** The transport's channel, and why the broker closed it (once it did). */
interface OpenChannel {
  channel: ConfirmChannel;
  closeReason?: string;
}

/**
 * The official outbox's RabbitMQ transport: publishes each message the relay
 * hands it to an exchange on a confirm channel, and resolves only when the
 * broker has taken responsibility for it. Ported from
 * `@nest-native/messaging/rabbitmq`, which this app used to run on: the wire
 * and the confirm rules are the same.
 *
 * A publish succeeds only when the broker ACKS it and did not RETURN it. Every
 * message is published `mandatory`, so a message no queue is bound for comes
 * back as a return before its ack. Without that, RabbitMQ acks an unroutable
 * message and drops it, and the outbox would count it published for nobody.
 *
 * Every failure is thrown as a plain `Error`, so the relay retries it with
 * backoff until `retry.attempts` and then dead-letters it. That includes an
 * unroutable message: the usual cause is a consumer that has not declared its
 * queue yet, which a retry fixes, while a routing mistake that never gets
 * fixed ends in the dead letters instead of retrying forever. When the broker
 * closed the channel, the failure carries its reason (a missing exchange, an
 * access error, an oversized message).
 *
 * The relay's `signal` bounds a publish (`relay.publishTimeout`): waiting for a
 * channel and waiting for the confirm both stop when it aborts. A failed
 * attempt is not proof the message was not delivered: one whose confirm came
 * too late may still have reached its queue, and the retry sends it again.
 * Delivery is at-least-once, which the consumers' inbox deduplicates.
 *
 * The value is JSON (`application/json`), the message is persistent, and the
 * wire matches the Kafka transport: `messageId` and `x-event-id` carry the
 * message id, `x-idempotency-key` the business key (or the id).
 */
export class RabbitOutboxTransport extends OutboxTransport {
  /** The channel being opened, or open: what the next publish uses. */
  private channel: Promise<OpenChannel> | undefined;
  private readonly returned = new Set<string>();

  constructor(private readonly options: RabbitOutboxTransportOptions) {
    super();
  }

  async publish(
    message: OutboxMessage,
    { signal }: { signal: AbortSignal },
  ): Promise<void> {
    const state = await abortable(this.openChannel(), signal);
    const routingKey = message.topic;
    const confirmed = new Promise<void>((resolve, reject) => {
      state.channel.publish(
        this.options.exchange,
        routingKey,
        Buffer.from(encodeWireValue(message.payload)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: message.id,
          headers: {
            ...message.headers,
            [X_EVENT_ID]: message.id,
            [X_IDEMPOTENCY_KEY]: message.headers[X_IDEMPOTENCY_KEY] ?? message.id,
          },
        },
        (error: unknown) => {
          // The broker sends a return BEFORE the ack of the same publish, so by
          // the time this callback runs the return handler has already fired.
          const wasReturned = this.returned.delete(message.id);
          if (error) {
            const why = state.closeReason ? ` (${state.closeReason})` : '';
            reject(
              new Error(
                `broker did not confirm message ${message.id}: ${describe(error)}${why}`,
              ),
            );
          } else if (wasReturned) {
            reject(
              new Error(
                `message ${message.id} is unroutable: no queue is bound to exchange ` +
                  `"${this.options.exchange}" for routing key "${routingKey}"`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
    try {
      await abortable(confirmed, signal);
    } finally {
      this.returned.delete(message.id);
    }
  }

  // One channel per transport, opened on first use and dropped when it closes
  // or errors, so the next publish opens a fresh one. With amqplib's recovering
  // connection that is what survives a broker restart: the connection comes
  // back on its own, channels do not. Each callback compares against the very
  // promise it belongs to, so a channel that closes (or fails to open) after a
  // newer one opened can never clear the current one.
  private openChannel(): Promise<OpenChannel> {
    if (this.channel) {
      return this.channel;
    }
    const opening: Promise<OpenChannel> = this.options.connection
      .createConfirmChannel()
      .then(
        (channel) => {
          const state: OpenChannel = { channel };
          const forget = (): void => {
            if (this.channel === opening) {
              this.channel = undefined;
            }
          };
          channel.on('return', (returned: Message) => {
            const id = returned.properties.messageId as string | undefined;
            if (id) this.returned.add(id);
          });
          // The broker's reason arrives as 'error' before amqplib fails the
          // unconfirmed publishes with a bare "channel closed"; keep it for
          // them. The listener also keeps the error from reaching
          // EventEmitter's unhandled-'error' throw.
          channel.on('error', (error: unknown) => {
            state.closeReason = describe(error);
            forget();
          });
          channel.on('close', forget);
          return state;
        },
        (error: unknown) => {
          if (this.channel === opening) {
            this.channel = undefined;
          }
          throw new Error(
            `could not open a RabbitMQ confirm channel: ${describe(error)}`,
          );
        },
      );
    this.channel = opening;
    return opening;
  }
}

/**
 * `work`, unless `signal` aborts first: then it rejects with the signal's
 * reason (the relay's publish timeout) and `work` goes on settling unobserved.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
