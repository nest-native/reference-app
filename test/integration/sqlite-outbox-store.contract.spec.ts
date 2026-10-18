import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { type OutboxMessage, OutboxStorage } from '@nestjs/outbox';
import {
  outboxInboxStoreContract,
  outboxStoreContract,
  type OutboxStoreHarness,
} from '@nestjs/outbox/testing';
import type { AppDatabase } from '../../src/database/database';
import { schema } from '../../src/database/schema';
import { SqliteOutboxStore } from '../../src/modules/outbox/sqlite-outbox.store';

// The official outbox's own contract suites, run against the app's SQLite
// store. Each case gets a fresh in-memory database on the app's real
// migrations (so a migration that drifts from the store fails here), and the
// store built as Nest builds it, registering itself with an OutboxStorage.
// better-sqlite3's transaction() cannot stay open across the awaits a case
// makes, so the harness opens one by hand on the connection.
function freshStore(): OutboxStoreHarness<AppDatabase> & {
  store: SqliteOutboxStore;
} {
  const sqlite = new Database(':memory:', { timeout: 5_000 });
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './src/database/migrations' });
  return {
    store: new SqliteOutboxStore(db, new OutboxStorage()),
    async transaction(work) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(db);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    notATransaction: db,
    close: () => {
      sqlite.close();
    },
  };
}

// These open a second transaction while the first is still open. On one
// connection that is "cannot start a transaction within a transaction", and a
// second connection in this process would stall the event loop in
// better-sqlite3's busy wait. The cross-process spec runs the first and the
// last across two processes instead; the race of producers and relays rests on
// the same single writer. Listed to exclude, not to include: a renamed case
// runs, and fails loudly, rather than going missing.
const OVERLAPPING_TRANSACTIONS = new Set([
  'publishes a key in commit order when producers overlap',
  'keeps each key in order while producers and relays race',
  'makes two deliveries of a message meet at the inbox key',
]);

// node:test runs a file's tests one after another, so no two cases share the
// connection.
describe('SqliteOutboxStore: the outbox store contract', () => {
  for (const c of outboxStoreContract(freshStore, { concurrent: true })) {
    if (!OVERLAPPING_TRANSACTIONS.has(c.name)) test(c.name, c.run);
  }
});

describe('SqliteOutboxStore: the inbox store contract', () => {
  for (const c of outboxInboxStoreContract(freshStore, { concurrent: true })) {
    if (!OVERLAPPING_TRANSACTIONS.has(c.name)) test(c.name, c.run);
  }
});

// A statement binds at most 32,766 variables. The app adds one message per
// transaction and the relay releases at most a batch, but the contract puts no
// bound on either: past one statement's worth, the store splits the work into
// several statements in one transaction.
describe('SqliteOutboxStore: more than one statement can bind', () => {
  const message = (id: string): OutboxMessage => ({
    id,
    topic: 'bulk',
    payload: { id },
    headers: {},
    key: null,
    createdAt: 1,
    availableAt: 1,
    attempts: 0,
    lastError: null,
  });
  const many = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`);

  test('adds 4,000 messages in one call, in the batch order, all or nothing', async () => {
    const harness = freshStore();
    const store: SqliteOutboxStore = harness.store;
    try {
      const batch = many('m', 4_000).map(message);
      await harness.transaction(async (tx) => store.add(tx, batch));
      await assert.rejects(
        harness.transaction(async (tx) => {
          store.add(tx, many('rolled-back', 4_000).map(message));
          throw new Error('the caller failed after add()');
        }),
        /the caller failed/,
      );

      const claimed = store.claim({ owner: 'r1', now: 2, leaseMs: 60_000, limit: 10_000 });
      assert.deepEqual(
        claimed.map((m) => m.id),
        batch.map((m) => m.id),
      );
    } finally {
      await harness.close?.();
    }
  });

  test('releases, requeues and purges by 40,000 ids', async () => {
    const harness = freshStore();
    const store: SqliteOutboxStore = harness.store;
    try {
      await harness.transaction(async (tx) =>
        store.add(tx, ['a', 'b', 'c', 'd'].map(message)),
      );
      store.claim({ owner: 'r1', now: 2, leaseMs: 60_000, limit: 10 });
      const failure = { attempt: 1, at: 3, error: 'boom' };
      for (const id of ['c', 'd']) {
        store.deadLetter(id, 'r1', { attempts: 1, reason: 'rejected', failedAt: 3, error: failure });
      }
      // The ids that exist come last, in the last statement.
      const missing = many('missing', 40_000);

      assert.equal(store.release([...missing, 'a', 'b'], 'r1'), 2);
      assert.equal(store.requeueDeadLetters({ ids: [...missing, 'c'] }, 4), 1);
      assert.equal(store.purgeDeadLetters({ ids: [...missing, 'd'] }), 1);
      assert.deepEqual(
        store.claim({ owner: 'r2', now: 5, leaseMs: 60_000, limit: 10 }).map((m) => m.id),
        ['a', 'b', 'c'],
      );
      assert.equal(store.getDeadLetter('d'), undefined);
    } finally {
      await harness.close?.();
    }
  });
});
