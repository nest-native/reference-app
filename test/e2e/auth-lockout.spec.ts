import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';
import { seedDatabase } from '../../scripts/seed';

const trpcPath = '/trpc';
const AUTH_SECRET = 'e2e-lockout-secret-must-be-at-least-32-characters';
const LIMIT = 3;

let app: INestApplication;
let baseUrl: string;

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-lockout-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = AUTH_SECRET;
  // Lock after a few failures so the test is fast and deterministic.
  process.env.LOCKOUT_LIMIT = String(LIMIT);
  process.env.LOCKOUT_COOLOFF_MS = String(15 * 60_000);

  seedDatabase(dbPath);

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app.close();
});

interface TrpcSuccess {
  result?: unknown;
  error?: SuperJSONResult;
}

/** Attempt a login and return the resulting HTTP status (200 on success). */
async function loginStatus(email: string, password: string): Promise<number> {
  const response = await fetch(`${baseUrl}${trpcPath}/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(superjson.serialize({ email, password })),
  });
  const body = (await response.json()) as TrpcSuccess;
  if (body.result !== undefined) {
    return 200;
  }
  const shape = superjson.deserialize<{ data: { httpStatus: number } }>(
    body.error as SuperJSONResult,
  );
  return shape.data.httpStatus;
}

test('locks an identity after the failure limit and refuses even the correct password', async () => {
  const email = 'admin@acme.test'; // the seeded admin

  // The first LIMIT wrong-password attempts are rejected as invalid (401) and
  // counted; the identity is not yet locked.
  for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
    assert.equal(
      await loginStatus(email, 'wrong-password'),
      401,
      `attempt ${attempt} should be 401 (invalid credentials)`,
    );
  }

  // Now locked: even the CORRECT password is refused with 429 Too Many Requests.
  // This is the whole point — the brute-force control gates before the
  // credential check.
  assert.equal(
    await loginStatus(email, 'admin123!'),
    429,
    'a locked identity is refused with 429 even with the right password',
  );
});
