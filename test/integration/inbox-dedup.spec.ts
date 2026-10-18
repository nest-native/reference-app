import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { OutboxInbox, type OutboxInboxResult } from '@nestjs/outbox';
import type { AppDatabase } from '../../src/database/database';
import { auditEvents, outboxInbox } from '../../src/database/schema';
import { AuditLogService } from '../../src/modules/audit-log/audit-log.service';
import { seedDatabase } from '../../scripts/seed';

// Hermetic: NO broker. The inbox dedup primitive is synchronous + DB-only on
// the app's SQLite store, so we drive OutboxInbox.processInTransaction(...)
// directly, inside a transaction, with a synthetic DB side effect (a
// synchronous audit-log write) and assert on the rows — exactly how the broker
// consumers' engines call it, minus the broker.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-inbox-dedup-${process.pid}-${Date.now()}.db`,
);

const CONSUMER = 'user.invited:test-group';

let app: INestApplicationContext;
let inbox: OutboxInbox;
let txHost: TransactionHost<TransactionalAdapterDrizzleOrm<AppDatabase>>;
let audit: AuditLogService;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;

// Count the inbox records for one key, and the audit rows the side effect
// wrote for it (the side effect stamps the dedup key into subject_id).
const inboxRows = (key: string) =>
  inspect
    .select()
    .from(outboxInbox)
    .where(
      and(eq(outboxInbox.consumer, CONSUMER), eq(outboxInbox.messageId, key)),
    )
    .all();

const auditRows = (key: string) =>
  inspect
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, 'user.invited.delivered'),
        eq(auditEvents.subjectId, key),
      ),
    )
    .all();

// The synchronous side effect the inbox runs in-transaction: write one audit
// row stamped with the dedup key so the test can count it precisely.
const sideEffect = (key: string) => () => {
  audit.record({
    orgId: seededOrgId,
    actorUserId: seededAdminId,
    action: 'user.invited.delivered',
    subjectType: 'user',
    subjectId: key,
    metadata: { dedupKey: key },
  });
};

// What a consumer's engine does with one delivery: record it in the inbox and
// run the side effect, in one transaction.
const processOnce = (
  key: string,
  work: () => void,
): Promise<OutboxInboxResult<void>> =>
  txHost.withTransaction(
    () =>
      inbox.processInTransaction(txHost.tx, CONSUMER, key, work) as Promise<
        OutboxInboxResult<void>
      >,
  );

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'inbox-dedup-test-secret-min-32-characters-xx';
  delete process.env.KAFKA_BROKERS; // ensure Kafka-off (in-process) profile
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  inbox = app.get(OutboxInbox);
  txHost = app.get(TransactionHost);
  audit = app.get(AuditLogService);
  inspect = app.get<AppDatabase>(getDrizzleToken());
});

after(async () => {
  await app.close();
});

test('first delivery processes the side effect and records exactly one row', async () => {
  const key = 'evt-first-delivery';

  const outcome = await processOnce(key, sideEffect(key));

  assert.equal(outcome.duplicate, false);
  assert.equal(inboxRows(key).length, 1, 'exactly one inbox record');
  assert.equal(auditRows(key).length, 1, 'side effect ran exactly once');
});

test('duplicate delivery is skipped: no second record, no second side effect', async () => {
  const key = 'evt-duplicate';

  const first = await processOnce(key, sideEffect(key));
  assert.equal(first.duplicate, false);
  assert.equal(inboxRows(key).length, 1);
  assert.equal(auditRows(key).length, 1);

  // Redelivery of the same key: the record exists, so the insert-if-absent
  // reports a duplicate, the side effect is skipped, and the count stays one.
  const second = await processOnce(key, sideEffect(key));
  assert.equal(second.duplicate, true);
  assert.equal(inboxRows(key).length, 1, 'still exactly one inbox record');
  assert.equal(auditRows(key).length, 1, 'side effect did NOT run again');
});

test('handler throw rolls back the inbox record, and a later good delivery reprocesses', async () => {
  const key = 'evt-rollback';

  // The side effect throws: the whole transaction (inbox record INCLUDED) must
  // roll back, leaving the key unprocessed so the broker can safely redeliver.
  await assert.rejects(() =>
    processOnce(key, () => {
      audit.record({
        orgId: seededOrgId,
        actorUserId: seededAdminId,
        action: 'user.invited.delivered',
        subjectType: 'user',
        subjectId: key,
        metadata: { dedupKey: key },
      });
      throw new Error('synthetic side-effect failure');
    }),
  );

  assert.equal(inboxRows(key).length, 0, 'no inbox record after rollback');
  assert.equal(auditRows(key).length, 0, 'audit write rolled back too');

  // The redelivery now succeeds and is processed exactly once — proof that the
  // failed attempt left nothing behind to block reprocessing.
  const retry = await processOnce(key, sideEffect(key));
  assert.equal(retry.duplicate, false);
  assert.equal(inboxRows(key).length, 1);
  assert.equal(auditRows(key).length, 1);
});
