import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import { schema } from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  sqlite: Database.Database;
}

export function createDatabase(url: string): DatabaseHandle {
  // The API and the worker write this file from two processes. A writer that
  // finds the lock held waits up to `timeout` ms for it; the outbox and job
  // claims open with BEGIN IMMEDIATE so that they wait here instead of failing
  // with "database is locked". 5 s is better-sqlite3's default, made explicit.
  const sqlite = new Database(url, { timeout: 5_000 });
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
