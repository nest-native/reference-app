import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import type { AppDatabase } from '../../src/database/database';
import { auditEvents, inboxEvents } from '../../src/database/schema';
import { AuditLogService } from '../../src/modules/audit-log/audit-log.service';
import { InboxService } from '../../src/modules/inbox/inbox.service';
import { seedDatabase } from '../../scripts/seed';

// Hermetic: NO broker. The inbox dedup primitive is synchronous + DB-only, so
// we drive InboxService.runOnce(...) directly with a synthetic DB side effect
// (a synchronous audit-log write) and assert on the rows — exactly how the
// Kafka consumer wrapper will call it, minus Kafka.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-inbox-dedup-${process.pid}-${Date.now()}.db`,
);

const SOURCE = 'user.invited:test-group';

let app: INestApplicationContext;
let inbox: InboxService;
let audit: AuditLogService;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;

// Count the inbox dedup rows for one key, and the audit rows the side effect
// wrote for it (the side effect stamps the dedup key into subject_id).
const inboxRows = (key: string) =>
  inspect
    .select()
    .from(inboxEvents)
    .where(
      and(eq(inboxEvents.source, SOURCE), eq(inboxEvents.messageKey, key)),
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
  });
  inbox = app.get(InboxService);
  audit = app.get(AuditLogService);
  inspect = app.get<AppDatabase>(getDrizzleClientToken());
});

after(async () => {
  await app.close();
});

test('first delivery processes the side effect and records exactly one row', async () => {
  const key = 'evt-first-delivery';

  const outcome = await inbox.runOnce(key, SOURCE, sideEffect(key));

  assert.equal(outcome, 'processed');
  assert.equal(inboxRows(key).length, 1, 'exactly one dedup row');
  assert.equal(auditRows(key).length, 1, 'side effect ran exactly once');
  assert.equal(inboxRows(key)[0]?.status, 'processed');
});

test('duplicate delivery is skipped: no second dedup row, no second side effect', async () => {
  const key = 'evt-duplicate';

  const first = await inbox.runOnce(key, SOURCE, sideEffect(key));
  assert.equal(first, 'processed');
  assert.equal(inboxRows(key).length, 1);
  assert.equal(auditRows(key).length, 1);

  // Redelivery of the same key: the unique index makes the insert a duplicate,
  // the side effect is skipped, and the row count stays at one.
  const second = await inbox.runOnce(key, SOURCE, sideEffect(key));
  assert.equal(second, 'duplicate');
  assert.equal(inboxRows(key).length, 1, 'still exactly one dedup row');
  assert.equal(auditRows(key).length, 1, 'side effect did NOT run again');
});

test('handler throw rolls back the dedup row, and a later good delivery reprocesses', async () => {
  const key = 'evt-rollback';

  // The side effect throws: the whole transaction (dedup row INCLUDED) must roll
  // back, leaving the key un-processed so the broker can safely redeliver.
  await assert.rejects(() =>
    inbox.runOnce(key, SOURCE, () => {
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

  assert.equal(inboxRows(key).length, 0, 'no dedup row after rollback');
  assert.equal(auditRows(key).length, 0, 'audit write rolled back too');

  // The redelivery now succeeds and is processed exactly once — proof that the
  // failed attempt left nothing behind to block reprocessing.
  const retry = await inbox.runOnce(key, SOURCE, sideEffect(key));
  assert.equal(retry, 'processed');
  assert.equal(inboxRows(key).length, 1);
  assert.equal(auditRows(key).length, 1);
});
