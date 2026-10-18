import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { OutboxStorage, type OutboxMessage } from '@nestjs/outbox';
import { schema } from '../../src/database/schema';
import {
  type SqliteDatabase,
  SqliteOutboxStore,
} from '../../src/modules/outbox/sqlite-outbox.store';

// The API and the worker are two processes on one SQLite file, and the
// contract suites cannot open a second connection in-process (see the contract
// spec). These cases put the second writer in a child process: it takes the
// write lock with BEGIN IMMEDIATE, optionally adds a message, says so, holds the
// lock for HOLD_MS and commits.
const HOLD_MS = 300;

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-outbox-cross-process-${process.pid}-${Date.now()}.db`,
);

const CHILD = `
const Database = require('better-sqlite3');
const [path, json] = process.argv.slice(1);
const db = new Database(path, { timeout: 5000 });
db.exec('BEGIN IMMEDIATE');
const m = JSON.parse(json);
if (m) {
  db.prepare('INSERT INTO outbox_messages (id, topic, payload, headers, key, created_at, available_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(m.id, m.topic, JSON.stringify(m.payload), JSON.stringify(m.headers), m.key, m.createdAt, m.availableAt);
}
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${HOLD_MS});
`;

let sqlite: Database.Database;
let db: SqliteDatabase;
let store: SqliteOutboxStore;

before(() => {
  // Opened the way createDatabase() opens the app's file: WAL, and a writer
  // that finds the lock held waits up to 5 s for it.
  sqlite = new Database(dbPath, { timeout: 5_000 });
  sqlite.pragma('journal_mode = WAL');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './src/database/migrations' });
  store = new SqliteOutboxStore(db, new OutboxStorage());
});

after(() => {
  sqlite.close();
});

/**
 * Starts the other writer and resolves once it holds the lock. It hands back
 * `{ exited }` rather than returning the exit promise itself: an async function
 * that returned it would make its caller wait for the exit right here.
 */
async function writerHoldingTheLock(
  message?: OutboxMessage,
): Promise<{ exited: Promise<unknown> }> {
  const child = spawn(
    process.execPath,
    ['-e', CHILD, dbPath, JSON.stringify(message ?? null)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`the other writer exited (${code}) before it held the lock`)),
    );
  });
  return { exited };
}

function message(topic: string, id: string, key: string | null): OutboxMessage {
  return {
    id,
    topic,
    payload: { topic },
    headers: {},
    key,
    createdAt: Date.now(),
    availableAt: 0,
    attempts: 0,
    lastError: null,
  };
}

const claimAll = (owner: string) =>
  store.claim({ owner, now: Date.now(), leaseMs: 60_000, limit: 100 });

test("a claim waits for the other process's write lock, and sees what it committed", async () => {
  db.transaction(() => store.add(db, [message('waiting', 'w-1', null)]), {
    behavior: 'immediate',
  });

  // A claim that read before it asked for the lock would fail here with
  // SQLITE_BUSY_SNAPSHOT once the other process commits: its snapshot would
  // be out of date, and SQLite does not wait in that case.
  const other = await writerHoldingTheLock(message('arrived', 'w-2', null));
  const started = Date.now();
  const claimed = claimAll('r1');
  const waited = Date.now() - started;
  await other.exited;

  assert.deepEqual(
    claimed.map((m) => m.topic),
    ['waiting', 'arrived'],
  );
  assert.ok(waited >= HOLD_MS - 50, `the claim waited ${waited} ms for the lock`);
  for (const m of claimed) assert.equal(store.markPublished(m.id, 'r1'), true);
});

test('keyed messages from two processes are numbered in commit order, whatever their ids', async () => {
  // The other process adds a1 and commits first. a2's id sorts before a1's (as
  // a UUIDv7 from a clock that runs behind would), but a2 cannot be numbered
  // until the other transaction lets go of the write lock.
  const other = await writerHoldingTheLock(
    message('a1', '0199a000-0000-7000-8000-000000000002', 'K'),
  );
  db.transaction(
    () =>
      store.add(db, [message('a2', '0199a000-0000-7000-8000-000000000001', 'K')]),
    { behavior: 'immediate' },
  );
  await other.exited;

  assert.deepEqual(
    claimAll('r2').map((m) => m.topic),
    ['a1', 'a2'],
  );
});
