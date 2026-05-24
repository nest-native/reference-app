import 'reflect-metadata';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { NestFactory } from '@nestjs/core';
import { organizations, schema } from '../src/database/schema';

async function smoke(): Promise<void> {
  const databaseUrl = join(
    tmpdir(),
    `nest-native-reference-app-smoke-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = databaseUrl;

  const sqlite = new Database(databaseUrl);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './src/database/migrations' });
  sqlite.close();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');

  try {
    const baseUrl = await app.getUrl();

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { status: string };
    assert.equal(healthBody.status, 'ok');

    const verifyConn = new Database(databaseUrl);
    const verifyDb = drizzle(verifyConn, { schema });
    const rows = verifyDb.select().from(organizations).all();
    assert.deepEqual(rows, []);
    verifyConn.close();

    console.warn('smoke: ok');
  } finally {
    await app.close();
  }
}

void smoke().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
