import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';

// Drives the task-summary request-reply exchange against the in-memory broker
// (KafkaTestModule) — the dummy broker address is NEVER dialed — so the whole
// round trip runs in plain CI with no real Kafka.
//
// Same env-before-dynamic-import discipline as the sibling Kafka spec:
// DatabaseModule opens SQLite from DATABASE_URL at module-load time and the
// consumer resolves its topic from env at module-load time, so everything that
// reads env at import must be pulled in via dynamic import() inside before().
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-kafka-rr-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let client: import('../../src/modules/task-summary/task-summary.client').TaskSummaryClient;
let inspect: import('../../src/database/database').AppDatabase;
let schema: typeof import('../../src/database/schema');
let seededOrgId: number;
let seededProjectId: number;
let seededUserId: number;
let otherOrgId: number;

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'kafka-rr-test-secret-min-32-characters-xx';
  process.env.KAFKA_BROKERS = 'inmemory:0';
  process.env.KAFKA_TOPIC_PREFIX = '';
  process.env.KAFKA_GROUP_ID = 'reference-app';

  const { seedDatabase } = await import('../../scripts/seed');
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededProjectId = seeded.project.id;
  seededUserId = seeded.admin.id;

  const kafka = await import('@nest-native/kafka/testing');
  schema = await import('../../src/database/schema');
  const { Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { ClsPluginTransactional } = await import('@nestjs-cls/transactional');
  const { TransactionalAdapterDrizzleOrm } = await import(
    '@nestjs-cls/transactional-adapter-drizzle-orm'
  );
  const { ClsModule } = await import('nestjs-cls');
  const { getDrizzleClientToken } = await import('@nest-native/drizzle');
  const { DatabaseModule } = await import('../../src/database/database.module');
  const { TaskSummaryClient } = await import(
    '../../src/modules/task-summary/task-summary.client'
  );
  const { TaskSummaryConsumer } = await import(
    '../../src/modules/task-summary/task-summary.consumer'
  );
  const { TASK_SUMMARY_REPLY_TOPIC } = await import(
    '../../src/modules/task-summary/task-summary.contract'
  );

  @Module({
    imports: [
      DatabaseModule,
      ClsModule.forRoot({
        global: true,
        plugins: [
          new ClsPluginTransactional({
            imports: [DatabaseModule],
            adapter: new TransactionalAdapterDrizzleOrm({
              drizzleInstanceToken: getDrizzleClientToken(),
            }),
            enableTransactionProxy: true,
          }),
        ],
      }),
      // The test module opts into request-reply exactly as AppModule's Kafka
      // profile does — the feature is inert without this block.
      kafka.KafkaTestModule.forRoot({
        requestReply: { replyTopic: TASK_SUMMARY_REPLY_TOPIC, timeoutMs: 5_000 },
      }),
    ],
    providers: [TaskSummaryConsumer, TaskSummaryClient],
  })
  class KafkaRequestReplyTestModule {}

  app = await NestFactory.createApplicationContext(KafkaRequestReplyTestModule, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  client = app.get(TaskSummaryClient);
  inspect = app.get(getDrizzleClientToken());

  // A second org whose tasks must never appear in the first org's summary.
  const otherOrg = inspect
    .insert(schema.organizations)
    .values({
      name: 'Other Org',
      slug: `other-${process.pid}`,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
  otherOrgId = otherOrg.id;
});

after(async () => {
  await app.close();
});

function addTask(orgId: number, status: 'open' | 'in_progress' | 'done'): void {
  inspect
    .insert(schema.tasks)
    .values({
      orgId,
      projectId: seededProjectId,
      title: `task-${status}-${Math.random().toString(36).slice(2, 8)}`,
      status,
      createdBy: seededUserId,
      createdAt: new Date().toISOString(),
    })
    .run();
}

test('answers a task summary over request-reply', async () => {
  addTask(seededOrgId, 'open');
  addTask(seededOrgId, 'open');
  addTask(seededOrgId, 'in_progress');
  addTask(seededOrgId, 'done');

  const answer = await client.summarize({ orgId: seededOrgId });

  assert.ok(answer, 'the request must be answered, not time out');
  assert.equal(answer.orgId, seededOrgId);
  assert.equal(answer.open, 2, 'two open tasks');
  assert.equal(answer.inProgress, 1);
  assert.equal(answer.done, 1);
});

test('scopes the summary to the asking org', async () => {
  // Tasks belonging to a different tenant must be invisible. A summary that
  // counted them would be a data-isolation bug, not a rounding error.
  addTask(otherOrgId, 'open');
  addTask(otherOrgId, 'open');
  addTask(otherOrgId, 'done');

  const other = await client.summarize({ orgId: otherOrgId });
  assert.ok(other);
  assert.equal(other.open, 2, "the other org sees only its own tasks");
  assert.equal(other.done, 1);

  const mine = await client.summarize({ orgId: seededOrgId });
  assert.ok(mine);
  assert.equal(
    mine.open,
    2,
    "the first org's counts must not move when another org gains tasks",
  );
});

test('a rejected query surfaces as a remote error, not a timeout', async () => {
  // The handler throws on a malformed query, which travels back as an error
  // reply: the caller learns immediately instead of waiting out the timeout.
  const started = Date.now();
  const answer = await client.summarize({
    orgId: 'not-a-number',
  } as unknown as { orgId: number });
  const elapsed = Date.now() - started;

  assert.equal(answer, undefined, 'a rejected query yields no summary');
  // `undefined` alone cannot tell an error reply from a timeout — both return
  // it. Without this bound the test passes by waiting out the 5s timeout, which
  // is exactly the behaviour it exists to rule out.
  assert.ok(
    elapsed < 1_000,
    `the rejection must come back as a reply, not a timeout (took ${elapsed}ms)`,
  );
});
