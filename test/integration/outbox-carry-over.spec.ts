import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { OutboxStorage } from '@nestjs/outbox';
import { schema } from '../../src/database/schema';
import {
  type SqliteDatabase,
  SqliteOutboxStore,
} from '../../src/modules/outbox/sqlite-outbox.store';

// Migrations 0008 and 0009 on a database @nest-native/messaging left rows in:
// the database is migrated up to 0007 (the official outbox's tables next to
// the old ones), given the old worker's rows, then migrated the rest of the way.
const MIGRATIONS = './src/database/migrations';
const LAST_BEFORE_CARRY_OVER = 7;

let workdir: string;
let sqlite: Database.Database;
let db: SqliteDatabase;

/** The migrations folder as far as `idx`: what drizzle's migrator reads, cut short. */
function migrationsUpTo(idx: number): string {
  const folder = join(workdir, 'migrations');
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const iso = (ms: number) => new Date(ms).toISOString();
const CREATED = Date.parse('2026-10-01T09:30:15.123Z');

before(() => {
  workdir = mkdtempSync(join(tmpdir(), 'nest-native-reference-app-carry-over-'));
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsUpTo(LAST_BEFORE_CARRY_OVER) });

  const event = sqlite.prepare(`INSERT INTO outbox_events
    (id, topic, payload, status, attempts, max_attempts, idempotency_key, available_at, processed_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?)`);
  // Waiting for the old worker, one of them after two failed attempts.
  event.run('evt-pending', 'task.created', '{"taskId":1}', 'pending', 0, 'task.created:1:1', iso(CREATED), null, null, iso(CREATED));
  event.run('evt-retrying', 'task.assigned', '{"taskId":1}', 'pending', 2, 'task.assigned:1:1:2', iso(CREATED + 60_456), null, 'broker down', iso(CREATED + 1));
  // Claimed by a worker that never finished it, and one without a business key.
  event.run('evt-processing', 'user.invited', '{"orgId":1}', 'processing', 0, null, iso(CREATED + 2), null, null, iso(CREATED + 2));
  // Done: nothing to publish.
  event.run('evt-completed', 'task.completed', '{"taskId":1}', 'completed', 0, 'task.completed:1:1', iso(CREATED + 3), iso(CREATED + 3), null, iso(CREATED + 3));
  // Given up on: out of attempts, and refused for good on its first one.
  event.run('evt-failed', 'task.completed', '{"taskId":2}', 'failed', 10, 'task.completed:1:2', iso(CREATED + 4), iso(CREATED + 90_007), 'boom', iso(CREATED + 4));
  event.run('evt-rejected', 'user.invited', '{"orgId":2}', 'failed', 1, null, iso(CREATED + 5), iso(CREATED + 5_250), 'user.invited: malformed payload', iso(CREATED + 5));

  const inbox = sqlite.prepare(`INSERT INTO inbox_events
    (id, message_key, source, status, processed_at, created_at) VALUES (?, ?, ?, 'processed', ?, ?)`);
  inbox.run('in-1', 'evt-earlier', 'user.invited:reference-app', iso(CREATED + 5), iso(CREATED + 5));
  inbox.run('in-2', 'evt-earlier', 'reference-app.user-invited', iso(CREATED + 6), iso(CREATED + 6));

  migrate(db, { migrationsFolder: MIGRATIONS });
});

after(() => {
  sqlite.close();
  rmSync(workdir, { recursive: true, force: true });
});

test('unpublished events move to outbox_messages with their ids, keys, attempts and exact times', () => {
  const rows = sqlite
    .prepare(
      'SELECT id, topic, payload, headers, key, created_at, available_at, attempts, last_error, lease_owner FROM outbox_messages ORDER BY seq',
    )
    .all();
  assert.deepEqual(rows, [
    {
      id: 'evt-pending',
      topic: 'task.created',
      payload: '{"taskId":1}',
      headers: '{"x-idempotency-key":"task.created:1:1"}',
      key: null,
      created_at: CREATED,
      available_at: CREATED,
      attempts: 0,
      last_error: null,
      lease_owner: null,
    },
    {
      id: 'evt-retrying',
      topic: 'task.assigned',
      payload: '{"taskId":1}',
      headers: '{"x-idempotency-key":"task.assigned:1:1:2"}',
      key: null,
      created_at: CREATED + 1,
      available_at: CREATED + 60_456,
      attempts: 2,
      last_error: 'broker down',
      lease_owner: null,
    },
    {
      id: 'evt-processing',
      topic: 'user.invited',
      payload: '{"orgId":1}',
      headers: '{}',
      key: null,
      created_at: CREATED + 2,
      available_at: CREATED + 2,
      attempts: 0,
      last_error: null,
      lease_owner: null,
    },
  ]);
});

test('events the old worker gave up on become dead letters, with their reason and exact times', () => {
  const rows = sqlite
    .prepare(
      'SELECT id, seq, topic, payload, headers, key, created_at, attempts, last_error, history, reason, failed_at FROM outbox_dead_letters ORDER BY seq',
    )
    .all();
  assert.deepEqual(rows, [
    {
      id: 'evt-failed',
      seq: -2,
      topic: 'task.completed',
      payload: '{"taskId":2}',
      headers: '{"x-idempotency-key":"task.completed:1:2"}',
      key: null,
      created_at: CREATED + 4,
      attempts: 10,
      last_error: 'boom',
      history: '[]',
      reason: 'exhausted',
      failed_at: CREATED + 90_007,
    },
    {
      id: 'evt-rejected',
      seq: -1,
      topic: 'user.invited',
      payload: '{"orgId":2}',
      headers: '{}',
      key: null,
      created_at: CREATED + 5,
      attempts: 1,
      last_error: 'user.invited: malformed payload',
      history: '[]',
      reason: 'rejected',
      failed_at: CREATED + 5_250,
    },
  ]);
});

test('the consumers keep their dedup records, under the same names', () => {
  const rows = sqlite
    .prepare('SELECT consumer, message_id, processed_at FROM outbox_inbox ORDER BY consumer')
    .all();
  assert.deepEqual(rows, [
    {
      consumer: 'reference-app.user-invited',
      message_id: 'evt-earlier',
      processed_at: CREATED + 6,
    },
    {
      consumer: 'user.invited:reference-app',
      message_id: 'evt-earlier',
      processed_at: CREATED + 5,
    },
  ]);
});

test('the old tables are gone', () => {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('outbox_events', 'inbox_events')",
    )
    .all();
  assert.deepEqual(tables, []);
});

test('a carried-over message is claimed like any other', () => {
  const store = new SqliteOutboxStore(db, new OutboxStorage());
  const claimed = store.claim({
    owner: 'relay',
    now: CREATED + 60_456,
    leaseMs: 1_000,
    limit: 10,
  });
  assert.deepEqual(
    claimed.map((message) => [message.id, message.headers, message.payload]),
    [
      ['evt-pending', { 'x-idempotency-key': 'task.created:1:1' }, { taskId: 1 }],
      ['evt-retrying', { 'x-idempotency-key': 'task.assigned:1:1:2' }, { taskId: 1 }],
      ['evt-processing', {}, { orgId: 1 }],
    ],
  );
});

test("a carried-over dead letter is listed and requeued like any other, and never takes a later message's seq", () => {
  const store = new SqliteOutboxStore(db, new OutboxStorage());
  assert.deepEqual(
    store.listDeadLetters({}).map((dead) => [dead.id, dead.reason]),
    [
      ['evt-failed', 'exhausted'],
      ['evt-rejected', 'rejected'],
    ],
  );

  const now = Date.now();
  // A message added since the upgrade takes the next AUTOINCREMENT seq; the
  // requeued dead letter goes back to its own, negative one, without a clash.
  db.transaction((tx) =>
    store.add(tx, [
      {
        id: 'after-upgrade',
        topic: 'task.created',
        payload: { taskId: 3 },
        headers: {},
        key: null,
        createdAt: now,
        availableAt: now,
        attempts: 0,
        lastError: null,
      },
    ]),
  );
  assert.equal(store.requeueDeadLetters({ all: true }, now), 2);
  assert.deepEqual(store.listDeadLetters({}), []);

  const claimed = store
    .claim({ owner: 'after-upgrade-relay', now, leaseMs: 1_000, limit: 10 })
    .map((message) => [message.id, message.attempts, message.lastError]);
  assert.deepEqual(
    claimed.filter(([id]) => id === 'evt-failed' || id === 'evt-rejected' || id === 'after-upgrade'),
    [
      ['evt-failed', 0, 'boom'],
      ['evt-rejected', 0, 'user.invited: malformed payload'],
      ['after-upgrade', 0, null],
    ],
  );
});
