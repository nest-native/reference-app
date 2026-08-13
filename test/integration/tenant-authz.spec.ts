import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { ContextIdFactory, NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { hashPassword } from '../../src/auth/password';
import { AuthService } from '../../src/auth/auth.service';
import type { AppDatabase } from '../../src/database/database';
import {
  memberships,
  organizations,
  outboxEvents,
  projects,
  tasks,
  users,
} from '../../src/database/schema';
import { OrganizationOnboardingService } from '../../src/modules/onboarding/organization-onboarding.service';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { seedDatabase } from '../../scripts/seed';

// Two tenants in one database. Everything here is run as the ACME admin and
// aims at RIVAL rows: the app must refuse to link them, and must refuse in a
// way that never reveals whether the foreign row exists.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-tenant-authz-${process.pid}-${Date.now()}.db`,
);

const MISSING_ID = 999_999;

let app: INestApplicationContext;
let tasksService: TasksService;
let onboarding: OrganizationOnboardingService;
let auth: AuthService;
let inspect: AppDatabase;
let acmeOrgId: number;
let acmeAdminId: number;
let acmeProjectId: number;
let rivalProjectId: number;
let rivalUserId: number;

const counts = () => ({
  tasks: inspect.select().from(tasks).all().length,
  outboxEvents: inspect.select().from(outboxEvents).all().length,
  users: inspect.select().from(users).all().length,
  memberships: inspect.select().from(memberships).all().length,
  projects: inspect.select().from(projects).all().length,
});

/** The id is the only part that may differ between the two error messages. */
const shape = (message: string, id: number) =>
  message.replace(String(id), '<id>');

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'tenant-authz-secret-at-least-32-chars-xxxxx';
  const seeded = seedDatabase(dbPath);
  acmeOrgId = seeded.org.id;
  acmeAdminId = seeded.admin.id;
  acmeProjectId = seeded.project.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  auth = app.get(AuthService);
  onboarding = app.get(OrganizationOnboardingService);
  inspect = app.get<AppDatabase>(getDrizzleClientToken());

  const nowIso = new Date().toISOString();
  const rivalOrg = inspect
    .insert(organizations)
    .values({ slug: 'rival', name: 'Rival Inc', createdAt: nowIso })
    .returning()
    .get();
  const rivalUser = inspect
    .insert(users)
    .values({
      email: 'boss@rival.test',
      passwordHash: hashPassword('rival-pass-12345'),
      createdAt: nowIso,
    })
    .returning()
    .get();
  rivalUserId = rivalUser.id;
  inspect
    .insert(memberships)
    .values({
      orgId: rivalOrg.id,
      userId: rivalUser.id,
      role: 'admin',
      createdAt: nowIso,
    })
    .run();
  rivalProjectId = inspect
    .insert(projects)
    .values({
      orgId: rivalOrg.id,
      name: 'Rival Roadmap',
      createdBy: rivalUser.id,
      createdAt: nowIso,
    })
    .returning()
    .get().id;

  // Same trick as tasks.workflow.spec: resolve the request-scoped service
  // against a registered request carrying the ACME tenant.
  const contextId = ContextIdFactory.create();
  app.registerRequestByContextId(
    {
      authContext: {
        user: { id: acmeAdminId },
        organization: { id: acmeOrgId },
      },
    },
    contextId,
  );
  tasksService = await app.resolve(TasksService, contextId);
});

after(async () => {
  await app.close();
});

test('createTask refuses a cross-org projectId exactly like a missing one, committing nothing', async () => {
  const before = counts();

  const crossOrgError = await tasksService
    .createTask({ projectId: rivalProjectId, title: 'Steal the roadmap' })
    .then(() => undefined)
    .catch((error: Error) => error);
  const missingError = await tasksService
    .createTask({ projectId: MISSING_ID, title: 'Steal nothing' })
    .then(() => undefined)
    .catch((error: Error) => error);

  assert.ok(crossOrgError instanceof Error);
  assert.ok(missingError instanceof Error);
  assert.equal(crossOrgError.message, `Project ${rivalProjectId} not found`);
  assert.equal(
    shape(crossOrgError.message, rivalProjectId),
    shape(missingError.message, MISSING_ID),
    'a foreign project must be indistinguishable from a nonexistent one',
  );

  // The transaction rolled back before any write: no task row, no outbox event.
  assert.deepEqual(counts(), before);
});

test('assignTask refuses a cross-org assignee exactly like a missing one, committing nothing', async () => {
  const task = await tasksService.createTask({
    projectId: acmeProjectId,
    title: 'Assignable work',
  });
  const before = counts();

  const crossOrgError = await tasksService
    .assignTask({ id: task.id, assigneeId: rivalUserId })
    .then(() => undefined)
    .catch((error: Error) => error);
  const missingError = await tasksService
    .assignTask({ id: task.id, assigneeId: MISSING_ID })
    .then(() => undefined)
    .catch((error: Error) => error);

  assert.ok(crossOrgError instanceof Error);
  assert.ok(missingError instanceof Error);
  assert.equal(
    crossOrgError.message,
    `User ${rivalUserId} is not a member of this organization`,
  );
  assert.equal(
    shape(crossOrgError.message, rivalUserId),
    shape(missingError.message, MISSING_ID),
    'a foreign member must be indistinguishable from a nonexistent user',
  );

  // No assignment was written and no task.assigned event was enqueued.
  assert.deepEqual(counts(), before);
  const row = inspect.select().from(tasks).where(eq(tasks.id, task.id)).get();
  assert.equal(row?.assigneeId, null);
  assert.equal(row?.status, 'open');
});

test('login puts the OLDEST membership in the token, stably across logins', async () => {
  const dualUser = inspect
    .insert(users)
    .values({
      email: 'dual@acme.test',
      passwordHash: hashPassword('dual-pass-12345'),
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
  const otherOrgId = inspect
    .select()
    .from(organizations)
    .where(eq(organizations.slug, 'rival'))
    .get()?.id;
  assert.ok(otherOrgId);

  // Insert the NEWER membership first, so row order (id) and createdAt order
  // disagree — only an explicit ordering can pick the same one twice.
  inspect
    .insert(memberships)
    .values({
      orgId: otherOrgId,
      userId: dualUser.id,
      role: 'member',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    .run();
  inspect
    .insert(memberships)
    .values({
      orgId: acmeOrgId,
      userId: dualUser.id,
      role: 'member',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    .run();

  const first = await auth.login(
    { email: 'dual@acme.test', password: 'dual-pass-12345' },
    '127.0.0.1',
  );
  const second = await auth.login(
    { email: 'dual@acme.test', password: 'dual-pass-12345' },
    '127.0.0.1',
  );

  assert.equal(first.organization?.id, acmeOrgId);
  assert.deepEqual(second.organization, first.organization);
});

test('invite refuses an existing account, so no admin can attach another tenant\'s user', async () => {
  const before = counts();

  const foreignError = await onboarding
    .inviteUser({
      orgId: acmeOrgId,
      invitedByUserId: acmeAdminId,
      email: 'boss@rival.test',
      projectName: 'Poached Project',
      initialPassword: 'poached-pass-12345',
    })
    .then(() => undefined)
    .catch((error: Error) => error);
  const insiderError = await onboarding
    .inviteUser({
      orgId: acmeOrgId,
      invitedByUserId: acmeAdminId,
      email: 'admin@acme.test',
      projectName: 'Duplicate Project',
      initialPassword: 'duplicate-pass-12345',
    })
    .then(() => undefined)
    .catch((error: Error) => error);

  assert.ok(foreignError instanceof Error);
  assert.ok(insiderError instanceof Error);
  assert.equal(
    foreignError.message,
    insiderError.message,
    "the refusal must not reveal which organization an address belongs to",
  );

  // The RIVAL admin gained no foothold in ACME — which is also what keeps
  // assignTask's membership predicate from being admin-grantable.
  const attached = inspect
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.orgId, acmeOrgId), eq(memberships.userId, rivalUserId)),
    )
    .get();
  assert.equal(attached, undefined);
  assert.deepEqual(counts(), before, 'a refused invite writes nothing');
});
