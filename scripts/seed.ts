import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadEnv } from '../src/config/env';
import { organizations, schema } from '../src/database/schema';

async function main(): Promise<void> {
  const env = loadEnv();
  const sqlite = new Database(env.databaseUrl);
  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder: './src/database/migrations' });

  const inserted = db
    .insert(organizations)
    .values({
      slug: 'acme',
      name: 'Acme Corp',
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning()
    .all();

  sqlite.close();

  console.warn(`Seeded ${inserted.length} organization(s) into ${env.databaseUrl}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
