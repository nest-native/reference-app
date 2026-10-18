import 'reflect-metadata';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { OutboxStorage } from '@nestjs/outbox';
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
// better-sqlite3's busy wait. Commit order across connections rests on
// SQLite's single writer instead, which the cross-process spec proves. Listed
// to exclude, not to include: a renamed case runs, and fails loudly, rather
// than going missing.
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
