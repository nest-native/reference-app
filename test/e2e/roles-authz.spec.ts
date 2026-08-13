import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';
import type { AppDatabase } from '../../src/database/database';
import { memberships } from '../../src/database/schema';
import { seedDatabase } from '../../scripts/seed';

// RBAC over the wire: the roles the invite flow hands out must actually decide
// what a caller may do. Everything here goes through the real tRPC stack so the
// guard COMPOSITION is under test, not just the guard class.
const trpcPath = '/trpc';
let app: INestApplication;
let baseUrl: string;
let inspect: AppDatabase;
let adminToken: string;
let memberToken: string;
let viewerToken: string;
let orgId: number;
let memberUserId: number;
let projectId: number;
let taskId: number;

interface TrpcSuccess { result: { data: SuperJSONResult } }
interface TrpcError { error: SuperJSONResult }
interface TrpcErrorShape { data: { httpStatus: number } }

async function post(path: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}${trpcPath}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(superjson.serialize(body)),
  });
}

async function mutate<T>(path: string, body: unknown, token: string): Promise<T> {
  const r = await post(path, body, token);
  assert.equal(r.status, 200, `POST ${path} expected 200`);
  const parsed = (await r.json()) as TrpcSuccess;
  return superjson.deserialize<T>(parsed.result.data);
}

/** The tRPC-mapped HTTP status of a rejected mutation. */
async function denied(path: string, body: unknown, token: string): Promise<number> {
  const r = await post(path, body, token);
  const parsed = (await r.json()) as TrpcError;
  return superjson.deserialize<TrpcErrorShape>(parsed.error).data.httpStatus;
}

async function login(email: string, password: string): Promise<string> {
  const result = await post('auth.login', { email, password });
  const parsed = (await result.json()) as TrpcSuccess;
  return superjson.deserialize<{ token: string }>(parsed.result.data).token;
}

async function readStatus(path: string, token: string): Promise<number> {
  const r = await fetch(`${baseUrl}${trpcPath}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return r.status;
}

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-roles-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = 'e2e-roles-secret-must-be-at-least-32-chars-x';
  const seeded = seedDatabase(dbPath);
  orgId = seeded.org.id;
  projectId = seeded.project.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  inspect = app.get<AppDatabase>(getDrizzleClientToken());

  adminToken = await login('admin@acme.test', 'admin123!');

  const invitedMember = await mutate<{ user: { id: number } }>(
    'users.invite',
    {
      email: 'member@acme.test',
      projectName: 'Member Project',
      initialPassword: 'member-pass-1',
      role: 'member',
    },
    adminToken,
  );
  memberUserId = invitedMember.user.id;
  await mutate(
    'users.invite',
    {
      email: 'viewer@acme.test',
      projectName: 'Viewer Project',
      initialPassword: 'viewer-pass-1',
      role: 'viewer',
    },
    adminToken,
  );

  memberToken = await login('member@acme.test', 'member-pass-1');
  viewerToken = await login('viewer@acme.test', 'viewer-pass-1');

  const task = await mutate<{ id: number }>(
    'tasks.create',
    { projectId, title: 'Work a viewer may only read' },
    adminToken,
  );
  taskId = task.id;
});

after(async () => {
  await app.close();
});

test('a viewer may read but not create, assign, complete, or open a project', async () => {
  assert.equal(await readStatus('projects.list', viewerToken), 200);

  assert.equal(
    await denied('tasks.create', { projectId, title: 'Viewer task' }, viewerToken),
    403,
  );
  assert.equal(
    await denied('tasks.assign', { id: taskId, assigneeId: memberUserId }, viewerToken),
    403,
  );
  assert.equal(await denied('tasks.complete', { id: taskId }, viewerToken), 403);
  assert.equal(
    await denied('projects.create', { name: 'Viewer Project 2' }, viewerToken),
    403,
  );
});

test('a member works tasks but cannot invite teammates', async () => {
  const task = await mutate<{ id: number; status: string }>(
    'tasks.create',
    { projectId, title: 'Member task' },
    memberToken,
  );
  assert.equal(task.status, 'open');

  assert.equal(
    await denied(
      'users.invite',
      {
        email: 'smuggled@acme.test',
        projectName: 'Smuggled Project',
        initialPassword: 'smuggled-pass-1',
        role: 'admin',
      },
      memberToken,
    ),
    403,
  );
});

test('an admin may invite, including minting another admin', async () => {
  const result = await mutate<{ membership: { role: string } }>(
    'users.invite',
    {
      email: 'second.admin@acme.test',
      projectName: 'Second Admin Project',
      initialPassword: 'second-admin-1',
      role: 'admin',
    },
    adminToken,
  );
  assert.equal(result.membership.role, 'admin');
});

test('revoking a membership blocks the next mutation on the already-issued token', async () => {
  // The JWT still says "org N" — RolesGuard re-reads the membership, so the
  // revocation lands on the next mutation instead of at token expiry.
  inspect
    .delete(memberships)
    .where(
      and(eq(memberships.orgId, orgId), eq(memberships.userId, memberUserId)),
    )
    .run();

  assert.equal(
    await denied('tasks.create', { projectId, title: 'After revocation' }, memberToken),
    403,
  );
  // Reads stay token-trusted until the token expires — the documented model.
  assert.equal(await readStatus('projects.list', memberToken), 200);
});
