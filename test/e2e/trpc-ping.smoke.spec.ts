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
import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';
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
  // The server runs `transformer: superjson`, so `result.data` on the raw
  // wire is a superjson envelope ({ json, meta? }) — decode it explicitly.
  const body = (await response.json()) as {
    result: { data: SuperJSONResult };
  };
  assert.equal(superjson.deserialize(body.result.data), 'pong');
});

test('responseMeta marks the public ping query as edge-cacheable', async () => {
  const response = await fetch(`${baseUrl}${trpcPath}/ping`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
});

test('responseMeta leaves failing procedures uncached', async () => {
  // auth.me without a token fails — errors never get the public cache header.
  const response = await fetch(`${baseUrl}${trpcPath}/auth.me`);
  assert.notEqual(response.status, 200);
  assert.equal(response.headers.get('cache-control'), null);
});

test('health endpoint reports ok', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string };
  assert.equal(body.status, 'ok');
});
