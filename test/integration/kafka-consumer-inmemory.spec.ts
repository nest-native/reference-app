import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';

// This spec drives the UserInvitedConsumer against the in-memory broker
// (KafkaTestModule) — the dummy broker address is NEVER dialed — so it covers
// the full consumer pipeline in plain CI with no real Kafka.
//
// DatabaseModule opens its SQLite handle from DATABASE_URL at module-load time,
// and the consumer resolves its topic/group/source from env at module-load time.
// ES module imports are hoisted, so everything that reads env at import MUST be
// pulled in via dynamic import() AFTER the env is set in before() — the same
// pattern the other integration specs use for AppModule.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-kafka-inmemory-${process.pid}-${Date.now()}.db`,
);

const TOPIC = 'user.invited'; // topic prefix is empty in this spec
const DLQ_TOPIC = `${TOPIC}.DLQ`;

interface UserInvitedPayloadShape {
  invitedEmail: string;
  invitedUserId: number;
  invitedByUserId: number;
  orgId: number;
  projectId: number;
}

// Resolved in before() after the dynamic imports.
type Mod = typeof import('@nest-native/kafka/testing');
type Schema = typeof import('../../src/database/schema');

let app: INestApplicationContext;
let broker: import('@nest-native/kafka/testing').InMemoryKafkaBroker;
let inspect: import('../../src/database/database').AppDatabase;
let kafka: Mod;
let schema: Schema;
let drizzleOps: typeof import('drizzle-orm');
let seededOrgId: number;
let seededAdminId: number;

const validPayload = (): UserInvitedPayloadShape => ({
  invitedEmail: 'inmem.invitee@acme.test',
  invitedUserId: 999,
  invitedByUserId: seededAdminId,
  orgId: seededOrgId,
  projectId: 1,
});

const deliveredAuditRows = (subjectId: string) =>
  inspect
    .select()
    .from(schema.auditEvents)
    .where(
      drizzleOps.and(
        drizzleOps.eq(schema.auditEvents.action, 'user.invited.delivered'),
        drizzleOps.eq(schema.auditEvents.subjectId, subjectId),
      ),
    )
    .all();

const inboxRowsForKey = (key: string) =>
  inspect
    .select()
    .from(schema.inboxEvents)
    .where(drizzleOps.eq(schema.inboxEvents.messageKey, key))
    .all();

async function deliver(
  key: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  await broker.emit(TOPIC, {
    key,
    value: payload === undefined ? null : JSON.stringify(payload),
    headers: { 'x-event-id': key, ...headers },
  });
  // Settle every in-flight handler pipeline (including DLQ produces).
  await broker.idle();
}

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'kafka-inmem-test-secret-min-32-characters-x';
  process.env.KAFKA_BROKERS = 'inmemory:0';
  process.env.KAFKA_TOPIC_PREFIX = '';
  process.env.KAFKA_GROUP_ID = 'reference-app';

  // Dynamic imports AFTER env is set (ESM hoists static imports above this).
  const { seedDatabase } = await import('../../scripts/seed');
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;

  kafka = await import('@nest-native/kafka/testing');
  schema = await import('../../src/database/schema');
  drizzleOps = await import('drizzle-orm');
  const { Module } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const { ClsPluginTransactional } = await import('@nestjs-cls/transactional');
  const { TransactionalAdapterDrizzleOrm } = await import(
    '@nestjs-cls/transactional-adapter-drizzle-orm'
  );
  const { ClsModule } = await import('nestjs-cls');
  const { getDrizzleClientToken } = await import('@nest-native/drizzle');
  const { DatabaseModule } = await import('../../src/database/database.module');
  const { AuditLogModule } = await import(
    '../../src/modules/audit-log/audit-log.module'
  );
  const { INBOX_STORE, InboxService } = await import('@nest-native/messaging');
  const { SqliteInboxStore } = await import('@nest-native/messaging/sqlite');
  const { KafkaInboxConsumer } = await import('@nest-native/messaging/kafka');
  const { UserInvitedConsumer } = await import(
    '../../src/modules/inbox/user-invited.consumer'
  );

  // Mirror AppModule's CLS + Drizzle transactional wiring so InboxService /
  // AuditLogService get their @InjectTransaction() proxy, and run the consumer
  // against the in-memory broker instead of a real cluster.
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
      AuditLogModule,
      kafka.KafkaTestModule.forRoot(),
    ],
    // Mirror MessagingModule's inbox wiring (the library's InboxService over the
    // SQLite inbox store) plus the library's KafkaInboxConsumer engine, then the
    // app's thin consumer shell on top.
    providers: [
      { provide: INBOX_STORE, useValue: new SqliteInboxStore() },
      InboxService,
      KafkaInboxConsumer,
      UserInvitedConsumer,
    ],
  })
  class KafkaInMemoryTestModule {}

  app = await NestFactory.createApplicationContext(KafkaInMemoryTestModule, {
    logger: false,
  });
  await app.init();
  broker = app.get(kafka.KAFKA_TEST_BROKER);
  inspect = app.get(getDrizzleClientToken());
});

after(async () => {
  await app.close();
});

test('consumes a user.invited message: writes one audit row and one inbox row', async () => {
  const key = 'inmem-evt-1';
  await deliver(key, validPayload());

  assert.equal(deliveredAuditRows('999').length, 1, 'one delivery audit row');
  assert.equal(inboxRowsForKey(key).length, 1, 'one inbox dedup row');
});

test('redelivery of the same key is deduplicated (still one inbox row)', async () => {
  const key = 'inmem-evt-dup';
  await deliver(key, validPayload());
  await deliver(key, validPayload()); // redelivery, same event id

  assert.equal(inboxRowsForKey(key).length, 1, 'redelivery writes no second row');
});

test('malformed payload is dead-lettered (DLQ message produced, no inbox row)', async () => {
  broker.reset();
  const key = 'inmem-evt-bad';
  await deliver(key, { not: 'a valid user.invited payload' });

  assert.equal(
    inboxRowsForKey(key).length,
    0,
    'poison message writes no inbox row',
  );
  const dlq = broker.getSentTo(DLQ_TOPIC);
  assert.equal(dlq.length, 1, 'one DLQ message produced');
  assert.equal(
    dlq[0]?.headers?.['x-error'] !== undefined,
    true,
    'x-error header set',
  );
});

test('message with no derivable key is dead-lettered', async () => {
  broker.reset();
  // No x-event-id header and no kafka key → not keyable → PermanentError → DLQ.
  await broker.emit(TOPIC, { value: JSON.stringify(validPayload()) });
  await broker.idle();

  assert.equal(
    broker.getSentTo(DLQ_TOPIC).length,
    1,
    'keyless message dead-lettered',
  );
});
