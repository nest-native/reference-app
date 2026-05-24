import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadEnv } from '../src/config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const sqlite = new Database(env.databaseUrl);
  const db = drizzle(sqlite);

  migrate(db, { migrationsFolder: './src/database/migrations' });
  sqlite.close();

  console.warn(`Migrations applied to ${env.databaseUrl}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
