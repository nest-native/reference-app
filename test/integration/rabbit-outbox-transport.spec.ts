import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { NonRetryableMessageError, type OutboxMessage } from '@nestjs/outbox';
import type { ConfirmChannel } from 'amqplib';
import { RabbitOutboxTransport } from '../../src/modules/rabbitmq/rabbit-outbox.transport';

// Unit test: no live broker. A fake confirm channel records what the transport
// publishes and answers each publish the way the broker would: an ack, a
// return before the ack (no queue bound), or a nack after closing the channel.
// The live spec proves the confirms against RabbitMQ 4; this one pins the
// rules that decide what the relay counts as published.

interface Published {
  exchange: string;
  routingKey: string;
  content: string;
  options: {
    persistent?: boolean;
    mandatory?: boolean;
    contentType?: string;
    messageId?: string;
    headers?: Record<string, unknown>;
  };
}

type Confirm = (error: unknown) => void;

/** A confirm channel whose broker answers through `respond`. */
class FakeConfirmChannel extends EventEmitter {
  readonly published: Published[] = [];

  constructor(
    private readonly respond: (
      channel: FakeConfirmChannel,
      sent: Published,
      confirm: Confirm,
    ) => void,
  ) {
    super();
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Published['options'],
    confirm: Confirm,
  ): boolean {
    const sent = { exchange, routingKey, content: content.toString('utf8'), options };
    this.published.push(sent);
    setImmediate(() => this.respond(this, sent, confirm));
    return true;
  }
}

const ack = (_channel: FakeConfirmChannel, _sent: Published, confirm: Confirm) =>
  confirm(null);

/** A transport on a connection that opens a new fake channel each time it is asked. */
function makeTransport(respond = ack) {
  const channels: FakeConfirmChannel[] = [];
  const transport = new RabbitOutboxTransport({
    connection: {
      createConfirmChannel: async () => {
        const channel = new FakeConfirmChannel(respond);
        channels.push(channel);
        return channel as unknown as ConfirmChannel;
      },
    },
    exchange: 'unit.events',
  });
  return { transport, channels };
}

function message(id: string, headers: Record<string, string> = {}): OutboxMessage {
  return {
    id,
    topic: 'task.created',
    payload: { taskId: 7 },
    headers,
    key: null,
    createdAt: Date.now(),
    availableAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
}

const live = () => ({ signal: new AbortController().signal });

test('publishes persistent, mandatory JSON to the exchange, the contract headers in order', async () => {
  const { transport, channels } = makeTransport();

  await transport.publish(
    message('evt-1', { 'x-idempotency-key': 'task.created:3:7' }),
    live(),
  );

  const [sent] = channels[0]?.published ?? [];
  assert.equal(sent?.exchange, 'unit.events');
  assert.equal(sent?.routingKey, 'task.created', 'the topic is the routing key');
  assert.deepEqual(JSON.parse(sent?.content ?? 'null'), { taskId: 7 });
  assert.equal(sent?.options.persistent, true);
  assert.equal(sent?.options.mandatory, true);
  assert.equal(sent?.options.contentType, 'application/json');
  assert.equal(sent?.options.messageId, 'evt-1');
  assert.deepEqual(Object.entries(sent?.options.headers ?? {}), [
    ['x-event-id', 'evt-1'],
    ['x-idempotency-key', 'task.created:3:7'],
  ]);
});

test('a message the broker returns (no queue bound) fails the attempt, so the relay retries it', async () => {
  // The broker sends basic.return before the ack of the same publish.
  const { transport } = makeTransport((channel, sent, confirm) => {
    channel.emit('return', { properties: { messageId: sent.options.messageId } });
    confirm(null);
  });

  // A plain error, which the relay retries with backoff: the usual cause is a
  // consumer that has not declared its queue yet.
  await assert.rejects(
    () => transport.publish(message('evt-unroutable'), live()),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof NonRetryableMessageError) &&
      /message evt-unroutable is unroutable: no queue is bound to exchange "unit\.events" for routing key "task\.created"/.test(
        error.message,
      ),
  );
});

test('a nack fails the attempt with the reason the broker closed the channel for', async () => {
  const { transport } = makeTransport((channel, _sent, confirm) => {
    channel.emit('error', new Error('NOT_FOUND - no exchange "unit.events"'));
    confirm(new Error('channel closed'));
  });

  await assert.rejects(
    () => transport.publish(message('evt-nacked'), live()),
    /broker did not confirm message evt-nacked: channel closed \(NOT_FOUND - no exchange "unit\.events"\)/,
  );
});

test('the relay giving up on an attempt stops the wait for its confirm', async () => {
  const { transport } = makeTransport(() => {
    // The confirm never comes.
  });
  const controller = new AbortController();

  const attempt = transport.publish(message('evt-slow'), { signal: controller.signal });
  setImmediate(() => controller.abort(new Error('publish timed out')));

  await assert.rejects(() => attempt, /publish timed out/);
});

test('a channel the broker closed is replaced by the next publish', async () => {
  const { transport, channels } = makeTransport();

  await transport.publish(message('evt-before'), live());
  channels[0]?.emit('close');
  await transport.publish(message('evt-after'), live());

  assert.equal(channels.length, 2, 'a second channel was opened');
  assert.deepEqual(
    channels.map((channel) => channel.published.map((sent) => sent.options.messageId)),
    [['evt-before'], ['evt-after']],
  );
});
