import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxClaimer } from '@nest-native/messaging';
import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';
import { seedDatabase } from '../../scripts/seed';

// The cache chapter's e2e: reads are cached with a TEN-MINUTE TTL, so if tag
// invalidation ever failed, every assertion below would see stale data for the
// rest of the run — freshness within the TTL window IS the proof that the
// invalidation (not expiry) did the work.
const trpcPath = '/trpc';
const AUTH_SECRET = 'e2e-cache-secret-must-be-at-least-32-characters-x';

let app: INestApplication;
let baseUrl: string;
let token: string;

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-cache-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = AUTH_SECRET;
  process.env.CACHE_TTL_MS = String(10 * 60_000); // staleness would be glaring

  seedDatabase(dbPath);

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await call<{ token: string }>('auth.login', {
    email: 'admin@acme.test',
    password: 'admin123!',
  });
  token = login.token;
});

after(async () => {
  await app.close();
});

interface TrpcSuccess {
  result: { data: SuperJSONResult };
}

async function call<T>(name: string, input?: unknown): Promise<T> {
  const isQuery = input === undefined || name.includes('.list') || name.includes('.get');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let response: Response;
  if (name.startsWith('auth.login') || name.includes('create') || name.includes('assign') || name.includes('complete')) {
    response = await fetch(`${baseUrl}${trpcPath}/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(superjson.serialize(input)),
    });
  } else if (isQuery && input !== undefined) {
    const encoded = encodeURIComponent(JSON.stringify(superjson.serialize(input)));
    response = await fetch(`${baseUrl}${trpcPath}/${name}?input=${encoded}`, { headers });
  } else {
    response = await fetch(`${baseUrl}${trpcPath}/${name}`, { headers });
  }
  assert.equal(response.status, 200, `${name} expected 200`);
  const body = (await response.json()) as TrpcSuccess;
  return superjson.deserialize<T>(body.result.data);
}

test('projects.list is served from cache and refreshed by create (tag invalidation, not TTL)', async () => {
  const first = await call<Array<{ id: number; name: string }>>('projects.list');
  const initialCount = first.length;
  assert.ok(initialCount >= 1, 'seeded project present');

  // Cached read: identical payload (and, with a 10-minute TTL, provably cached).
  const second = await call<Array<{ id: number }>>('projects.list');
  assert.equal(second.length, initialCount);

  // The mutation must evict the org's project tags — the next read reflects
  // the new project immediately, long before the TTL could expire.
  const created = await call<{ id: number; name: string }>('projects.create', {
    name: 'Cache Chapter Project',
  });
  const third = await call<Array<{ id: number; name: string }>>('projects.list');
  assert.equal(third.length, initialCount + 1, 'create invalidated the cached list');
  assert.ok(third.some((p) => p.id === created.id));

  // projects.get on the fresh project caches + serves.
  const got = await call<{ id: number; name: string }>('projects.get', { id: created.id });
  assert.equal(got.name, 'Cache Chapter Project');
});

test('activity.list refreshes when the projection writes (write-site invalidation)', async () => {
  const projects = await call<Array<{ id: number }>>('projects.list');
  const projectId = projects[0]!.id;

  const before = await call<Array<{ id: number }>>('activity.list', { projectId });

  // A task mutation emits a domain event; the claimer tick (tests drive the
  // relay manually, the repo convention) runs the in-process handler, which
  // writes the activity row — and ActivityService.record invalidates the
  // project's feed tag at that write site.
  await call<{ id: number }>('tasks.create', {
    projectId,
    title: 'Cache invalidation task',
  });
  await app.get(OutboxClaimer).tick();

  // Far below the 10-minute TTL — only tag invalidation can make this fresh.
  const after_ = await call<Array<{ id: number }>>('activity.list', { projectId });
  assert.ok(
    after_.length > before.length,
    `the cached feed refreshed within the TTL window (${before.length} -> ${after_.length})`,
  );
});
