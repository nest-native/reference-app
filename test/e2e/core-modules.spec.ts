import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { seedDatabase } from '../../scripts/seed';

const trpcPath = '/trpc';
let app: INestApplication;
let baseUrl: string;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });

interface TrpcSuccess<T> { result: { data: T } }
interface TrpcError { error: { data: { httpStatus: number } } }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${trpcPath}/${path}`, { headers: auth() });
  assert.equal(r.status, 200, `GET ${path} expected 200`);
  return ((await r.json()) as TrpcSuccess<T>).result.data;
}

async function getWithInput<T>(path: string, input: unknown): Promise<T> {
  const encoded = encodeURIComponent(JSON.stringify(input));
  const r = await fetch(`${baseUrl}${trpcPath}/${path}?input=${encoded}`, {
    headers: auth(),
  });
  assert.equal(r.status, 200, `GET ${path} expected 200`);
  return ((await r.json()) as TrpcSuccess<T>).result.data;
}

async function postMutation<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}${trpcPath}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, `POST ${path} expected 200`);
  return ((await r.json()) as TrpcSuccess<T>).result.data;
}

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-core-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET =
    'e2e-core-secret-must-be-at-least-32-characters-xx';
  seedDatabase(dbPath);

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await fetch(`${baseUrl}${trpcPath}/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@acme.test', password: 'admin123!' }),
  }).then((r) => r.json()) as TrpcSuccess<{ token: string }>;
  token = login.result.data.token;
});

after(async () => {
  await app.close();
});

test('organizations.current returns the acme org', async () => {
  const org = await get<{ slug: string; name: string }>('organizations.current');
  assert.equal(org.slug, 'acme');
  assert.equal(org.name, 'Acme Corp');
});

test('organizations.list returns memberships for the current user', async () => {
  const orgs = await get<{ slug: string }[]>('organizations.list');
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0]?.slug, 'acme');
});

test('users.me returns the authed user', async () => {
  const me = await get<{ email: string }>('users.me');
  assert.equal(me.email, 'admin@acme.test');
});

test('users.list returns members of the current org', async () => {
  const members = await get<{ email: string; role: string }[]>('users.list');
  assert.equal(members.length, 1);
  assert.equal(members[0]?.email, 'admin@acme.test');
  assert.equal(members[0]?.role, 'admin');
});

test('projects.list returns the seeded Starter Project', async () => {
  const projects = await get<{ name: string }[]>('projects.list');
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, 'Starter Project');
});

test('projects.create persists a project scoped to current org and user', async () => {
  const before = await get<unknown[]>('projects.list');
  const created = await postMutation<{
    id: number;
    name: string;
    orgId: number;
    createdBy: number;
  }>('projects.create', { name: 'Second Project' });
  assert.equal(created.name, 'Second Project');
  assert.ok(created.id > 0);
  assert.ok(created.orgId > 0);
  assert.ok(created.createdBy > 0);

  const after = await get<{ id: number; name: string }[]>('projects.list');
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((p) => p.id === created.id));
});

test('projects.get fetches a project by id within the current org', async () => {
  const created = await postMutation<{ id: number; name: string }>(
    'projects.create',
    { name: 'Lookup Target' },
  );
  const fetched = await getWithInput<{ id: number; name: string }>(
    'projects.get',
    { id: created.id },
  );
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.name, 'Lookup Target');
});

test('projects.get returns httpStatus 404 for an unknown id', async () => {
  const r = await fetch(
    `${baseUrl}${trpcPath}/projects.get?input=${encodeURIComponent(
      JSON.stringify({ id: 999_999 }),
    )}`,
    { headers: auth() },
  );
  const body = (await r.json()) as TrpcError;
  assert.equal(body.error.data.httpStatus, 404);
});

test('organizations.current without auth returns httpStatus 401', async () => {
  const r = await fetch(`${baseUrl}${trpcPath}/organizations.current`);
  const body = (await r.json()) as TrpcError;
  assert.equal(body.error.data.httpStatus, 401);
});

test('projects.create without auth returns httpStatus 401', async () => {
  const r = await fetch(`${baseUrl}${trpcPath}/projects.create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unauthorized' }),
  });
  const body = (await r.json()) as TrpcError;
  assert.equal(body.error.data.httpStatus, 401);
});
