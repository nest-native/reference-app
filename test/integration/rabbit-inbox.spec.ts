import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
// Static, unlike the env-reading imports in before(): the CLS packages ship
// separate ESM and CommonJS builds, and under tsx an import() of an ESM-only
// @nestjs/* package loads a second copy (see kafka-consumer-inmemory.spec.ts).
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getDrizzleToken } from '@nestjs/drizzle';
import { NonRetryableMessageError, OutboxModule } from '@nestjs/outbox';
import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { ClsModule } from 'nestjs-cls';
import type {
  RabbitConsumeOptions,
  RabbitInbox,
} from '../../src/modules/rabbitmq/rabbit-inbox';

// Unit test: no live broker. The RabbitInbox engine against fake channels, on
// the app's SQLite store: what it settles a delivery as, and what it sends to
// the dead letters, in the cases a live broker cannot be made to produce on
// demand. The live spec (reliable-messaging.rabbitmq.spec.ts) covers the happy
// path, redelivery, poison and reconnects against RabbitMQ 4.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-rabbit-inbox-${process.pid}-${Date.now()}.db`,
);

const CONSUMER = 'unit.rabbit-queue';

let app: INestApplicationContext;
let inbox: RabbitInbox;

/** The channel a delivery arrived on: records how it was settled. */
class FakeChannel {
  readonly settled: string[] = [];
  ack(): void {
    this.settled.push('ack');
  }
  nack(_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean): void {
    this.settled.push(requeue ? 'requeue' : 'reject');
  }
}

interface DeadLetterCopy {
  exchange: string;
  routingKey: string;
  headers: Record<string, unknown>;
}

type Confirm = (error: unknown) => void;

/** The dead-letter confirm channel: records each copy and answers through `respond`. */
class FakeDeadLetterChannel extends EventEmitter {
  readonly copies: DeadLetterCopy[] = [];
  respond: (channel: FakeDeadLetterChannel, copy: DeadLetterCopy, confirm: Confirm) => void =
    (_channel, _copy, confirm) => confirm(null);

  publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: { headers: Record<string, unknown> },
    confirm: Confirm,
  ): boolean {
    const copy = { exchange, routingKey, headers: options.headers };
    this.copies.push(copy);
    setImmediate(() => this.respond(this, copy, confirm));
    return true;
  }
}

let delivered = 0;

function delivery(
  headers: Record<string, unknown>,
  { messageId, body = { ok: true } }: { messageId?: string; body?: unknown } = {},
): ConsumeMessage {
  delivered += 1;
  return {
    content: Buffer.from(JSON.stringify(body)),
    fields: {
      deliveryTag: delivered,
      redelivered: false,
      exchange: 'unit.events',
      routingKey: 'unit.topic',
      consumerTag: 'unit',
    },
    properties: { headers, messageId },
  } as unknown as ConsumeMessage;
}

function options(
  channel: FakeChannel,
  deadLetters: FakeDeadLetterChannel,
  message: ConsumeMessage,
  overrides: Partial<RabbitConsumeOptions<unknown>> = {},
): RabbitConsumeOptions<unknown> {
  return {
    consumer: CONSUMER,
    channel: channel as unknown as Channel,
    message,
    validate: (payload): payload is unknown => payload !== null,
    sideEffect: () => {},
    deadLetter: {
      channel: deadLetters as unknown as ConfirmChannel,
      exchange: 'unit.dlx',
      routingKey: CONSUMER,
    },
    retry: { delayMs: 1, maxDelayMs: 4 },
    ...overrides,
  };
}

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'rabbit-inbox-unit-secret-min-32-characters-x';
  delete process.env.KAFKA_BROKERS;
  delete process.env.RABBITMQ_URL;

  const { seedDatabase } = await import('../../scripts/seed');
  seedDatabase(dbPath);

  const { DatabaseModule } = await import('../../src/database/database.module');
  const { sqliteOutboxStoreProvider } = await import(
    '../../src/modules/outbox/sqlite-outbox.store'
  );
  const { RabbitInbox: Engine } = await import('../../src/modules/rabbitmq/rabbit-inbox');

  // AppModule's CLS and outbox wiring, with nothing but the engine on top.
  @Module({
    imports: [
      DatabaseModule,
      ClsModule.forRoot({
        global: true,
        plugins: [
          new ClsPluginTransactional({
            imports: [DatabaseModule],
            adapter: new TransactionalAdapterDrizzleOrm({
              drizzleInstanceToken: getDrizzleToken(),
            }),
            enableTransactionProxy: true,
          }),
        ],
      }),
      OutboxModule.forRoot({ relay: { enabled: false } }),
    ],
    providers: [sqliteOutboxStoreProvider, Engine],
  })
  class RabbitInboxTestModule {}

  app = await NestFactory.createApplicationContext(RabbitInboxTestModule, {
    logger: false,
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  inbox = app.get(Engine);
});

after(async () => {
  await app.close();
});

test('a delivery is processed and acked once; its redelivery is acked as a duplicate', async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();
  let runs = 0;
  const sideEffect = () => {
    runs += 1;
  };

  const first = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-once' }), { sideEffect }),
  );
  const again = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-once' }), { sideEffect }),
  );

  assert.deepEqual([first, again], [
    { outcome: 'processed', dedupKey: 'evt-once' },
    { outcome: 'duplicate', dedupKey: 'evt-once' },
  ]);
  assert.equal(runs, 1);
  assert.deepEqual(channel.settled, ['ack', 'ack']);
});

test('an integer x-event-id beyond 2^53 is dead-lettered with that reason, never used as a key', async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();

  // amqplib decodes a 64-bit integer header through a double: 2^53 + 2 and
  // 2^53 + 3 arrive as the same number.
  const result = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 2 ** 53 + 2 })),
  );

  assert.deepEqual(result, { outcome: 'dead-lettered' });
  assert.match(
    String(deadLetters.copies[0]?.headers['x-error']),
    /^x-event-id 9007199254740994 is an integer beyond 2\^53/,
  );
  assert.deepEqual(channel.settled, ['ack'], 'stored in the dead letters, so the original is acked');
});

test("the dead-letter copy's x-error is cut at 1,000 characters, saying how much was left out", async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();
  const longReason = 'x'.repeat(5_000);

  await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-long-reason' }), {
      validate: (_payload): _payload is unknown => {
        throw new Error(longReason);
      },
    }),
  );

  // "validate threw: " (16 characters) + the reason, cut to 1,000.
  const reason = String(deadLetters.copies[0]?.headers['x-error']);
  assert.equal(reason, `validate threw: ${'x'.repeat(984)}… (4016 more characters)`);
});

test('a dead-letter copy that fails to publish leaves the original requeued after a backoff, never dropped', async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();
  deadLetters.respond = (_channel, _copy, confirm) => confirm(new Error('dead-letter exchange gone'));

  const result = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-poison' }, { body: null })),
  );

  assert.deepEqual(result, { outcome: 'requeued', dedupKey: 'evt-poison' });
  assert.deepEqual(channel.settled, ['requeue']);
});

test('a dead-letter copy the broker returns (no queue bound) also leaves the original requeued', async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();
  deadLetters.respond = (dlc, copy, confirm) => {
    dlc.emit('return', { properties: { headers: copy.headers } });
    confirm(null);
  };

  const result = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-unroutable-copy' }, { body: null })),
  );

  assert.deepEqual(result, { outcome: 'requeued', dedupKey: 'evt-unroutable-copy' });
  assert.deepEqual(channel.settled, ['requeue']);
});

test('retry.maxAttempts dead-letters a delivery that keeps failing, with the last error', async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();
  const failing = {
    retry: { delayMs: 1, maxDelayMs: 4, maxAttempts: 2 },
    sideEffect: () => {
      throw new Error('database is down');
    },
  };

  const first = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-flaky' }), failing),
  );
  const second = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-flaky' }), failing),
  );

  assert.deepEqual([first.outcome, second.outcome], ['requeued', 'dead-lettered']);
  assert.equal(
    deadLetters.copies[0]?.headers['x-error'],
    'gave up after 2 attempts: database is down',
  );
  assert.deepEqual(channel.settled, ['requeue', 'ack']);
});

test("the dead-letter channel's 'error' listener keeps a channel the broker closes from throwing", async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();
  assert.equal(deadLetters.listenerCount('error'), 0);

  await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-watch' }, { body: null })),
  );

  // Without a listener, EventEmitter throws an 'error' it emits: out of
  // amqplib, that would close the whole connection (or end the process).
  assert.equal(deadLetters.listenerCount('error'), 1);
  assert.doesNotThrow(() =>
    deadLetters.emit('error', new Error('ACCESS_REFUSED - write to exchange "unit.dlx"')),
  );
});

test('a NonRetryableMessageError from the side effect is dead-lettered at once', async () => {
  const channel = new FakeChannel();
  const deadLetters = new FakeDeadLetterChannel();

  const result = await inbox.consume(
    options(channel, deadLetters, delivery({ 'x-event-id': 'evt-refused' }), {
      sideEffect: () => {
        throw new NonRetryableMessageError('refused for good');
      },
    }),
  );

  assert.deepEqual(result, { outcome: 'dead-lettered', dedupKey: 'evt-refused' });
  assert.equal(deadLetters.copies[0]?.headers['x-error'], 'refused for good');
  assert.equal(deadLetters.copies[0]?.headers['x-event-id'], 'evt-refused', 'the original headers ride along');
});
