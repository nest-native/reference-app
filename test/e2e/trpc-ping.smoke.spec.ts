import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { schema } from '../../src/database/schema';

let app: INestApplication;
let baseUrl: string;
const trpcPath = '/trpc';

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-test-trpc-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './src/database/migrations' });
  sqlite.close();

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app.close();
});

test('ping query returns "pong" over HTTP', async () => {
  const response = await fetch(`${baseUrl}${trpcPath}/ping`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { data: string } };
  assert.equal(body.result.data, 'pong');
});

test('health endpoint reports ok', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string };
  assert.equal(body.status, 'ok');
});
