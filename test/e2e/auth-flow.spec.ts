import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { seedDatabase } from '../../scripts/seed';

const trpcPath = '/trpc';
const AUTH_SECRET = 'e2e-test-secret-must-be-at-least-32-characters-xxx';

let app: INestApplication;
let baseUrl: string;

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-auth-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = AUTH_SECRET;

  seedDatabase(dbPath);

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app.close();
});

interface TrpcSuccess<T> {
  result: { data: T };
}

interface TrpcError {
  error: { message: string; data: { httpStatus: number } };
}

async function postMutation<T>(name: string, input: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${trpcPath}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200, `mutation ${name} expected 200`);
  const body = (await response.json()) as TrpcSuccess<T>;
  return body.result.data;
}

test('auth.login returns a token and user metadata for the seeded admin', async () => {
  const data = await postMutation<{
    token: string;
    user: { id: number; email: string };
    organization: { id: number } | null;
  }>('auth.login', { email: 'admin@acme.test', password: 'admin123!' });

  assert.equal(data.user.email, 'admin@acme.test');
  assert.equal(typeof data.token, 'string');
  assert.ok(data.token.split('.').length === 3, 'token must be a 3-part JWT');
  assert.ok(data.organization !== null, 'admin should have an organization');
});

test('auth.login rejects the wrong password with httpStatus 401', async () => {
  const response = await fetch(`${baseUrl}${trpcPath}/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@acme.test', password: 'wrong' }),
  });
  const body = (await response.json()) as TrpcError;
  assert.equal(body.error.data.httpStatus, 401);
});

test('auth.me without a token returns httpStatus 401', async () => {
  const response = await fetch(`${baseUrl}${trpcPath}/auth.me`);
  const body = (await response.json()) as TrpcError;
  assert.equal(body.error.data.httpStatus, 401);
});

test('auth.me with a valid token returns the current user and organization', async () => {
  const login = await postMutation<{ token: string }>('auth.login', {
    email: 'admin@acme.test',
    password: 'admin123!',
  });

  const response = await fetch(`${baseUrl}${trpcPath}/auth.me`, {
    headers: { authorization: `Bearer ${login.token}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as TrpcSuccess<{
    user: { id: number };
    organization: { id: number } | null;
  }>;
  assert.equal(typeof body.result.data.user.id, 'number');
  assert.ok(body.result.data.organization !== null);
});

test('auth.me with an invalid token returns httpStatus 401', async () => {
  const response = await fetch(`${baseUrl}${trpcPath}/auth.me`, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  const body = (await response.json()) as TrpcError;
  assert.equal(body.error.data.httpStatus, 401);
});
