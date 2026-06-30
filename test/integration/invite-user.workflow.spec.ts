import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import type { AppDatabase } from '../../src/database/database';
import {
  auditEvents,
  memberships,
  outboxEvents,
  projects,
  users,
} from '../../src/database/schema';
import { OutboxClaimer } from '@nest-native/messaging';
import { FakeEmailTransport } from '../../src/modules/outbox/fake-email-transport.service';
import { OrganizationOnboardingService } from '../../src/modules/onboarding/organization-onboarding.service';
import { ProjectsRepository } from '../../src/modules/projects/projects.repository';
import { seedDatabase } from '../../scripts/seed';

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-invite-workflow-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let onboarding: OrganizationOnboardingService;
let projectsRepo: ProjectsRepository;
let claimer: OutboxClaimer;
let transport: FakeEmailTransport;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;

const countAll = () => ({
  users: inspect.select().from(users).all().length,
  memberships: inspect.select().from(memberships).all().length,
  projects: inspect.select().from(projects).all().length,
  auditEvents: inspect.select().from(auditEvents).all().length,
  outboxEvents: inspect.select().from(outboxEvents).all().length,
});

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET =
    'workflow-test-secret-must-be-at-least-32-chars-xx';
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  onboarding = app.get(OrganizationOnboardingService);
  projectsRepo = app.get(ProjectsRepository);
  claimer = app.get(OutboxClaimer);
  transport = app.get(FakeEmailTransport);
  inspect = app.get<AppDatabase>(getDrizzleClientToken());
});

after(async () => {
  await app.close();
});

test('happy path: inviteUser persists 5 rows; worker delivers email; idempotency_key set', async () => {
  transport.reset();
  const before = countAll();

  const result = await onboarding.inviteUser({
    orgId: seededOrgId,
    invitedByUserId: seededAdminId,
    email: 'invitee.happy@acme.test',
    projectName: 'Happy Path Project',
    initialPassword: 'temp-pass-12345',
    role: 'member',
  });

  const after = countAll();
  assert.equal(after.users, before.users + 1);
  assert.equal(after.memberships, before.memberships + 1);
  assert.equal(after.projects, before.projects + 1);
  assert.equal(after.auditEvents, before.auditEvents + 1);
  assert.equal(after.outboxEvents, before.outboxEvents + 1);

  const outbox = inspect
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, result.outboxEventId))
    .get();
  assert.ok(outbox);
  assert.equal(outbox.status, 'pending');
  assert.equal(outbox.topic, 'user.invited');
  assert.ok(outbox.idempotencyKey?.startsWith('user.invited:'));

  const report = await claimer.tick();
  assert.equal(report.claimed, 1);
  assert.equal(report.completed, 1);

  const afterTick = inspect
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, result.outboxEventId))
    .get();
  assert.equal(afterTick?.status, 'completed');
  assert.ok(afterTick?.processedAt);

  const sent = transport.list();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, 'invitee.happy@acme.test');
});

test('rollback safety: throw between steps 3 and 4 leaves no rows from this transaction', async () => {
  transport.reset();
  const before = countAll();

  // Override on the exact instance that OrganizationOnboardingService holds
  // — each DrizzleModule.forFeature([...]) creates its own provider, so
  // app.get(ProjectsRepository) may return a different instance than
  // onboarding's injected dep.
  const injected = (onboarding as unknown as { projects: ProjectsRepository })
    .projects;
  const originalCreate = injected.create.bind(injected);
  injected.create = () => {
    throw new Error('synthetic failure between project insert and audit event');
  };

  try {
    await assert.rejects(() =>
      onboarding.inviteUser({
        orgId: seededOrgId,
        invitedByUserId: seededAdminId,
        email: 'rollback.victim@acme.test',
        projectName: 'Rollback Project',
        initialPassword: 'temp-pass-12345',
      }),
    );
  } finally {
    injected.create = originalCreate;
  }

  const after = countAll();
  assert.deepEqual(after, before, 'transaction must leave no partial rows');

  const orphan = inspect
    .select()
    .from(users)
    .where(eq(users.email, 'rollback.victim@acme.test'))
    .get();
  assert.equal(orphan, undefined);

  assert.equal(transport.list().length, 0);
});

test('worker crash recovery: stuck processing row is re-claimed and processed once', async () => {
  transport.reset();

  const result = await onboarding.inviteUser({
    orgId: seededOrgId,
    invitedByUserId: seededAdminId,
    email: 'crash.recovery@acme.test',
    projectName: 'Crash Recovery Project',
    initialPassword: 'temp-pass-12345',
  });

  // Simulate a worker that claimed this event then died: status=processing,
  // claimed_at well in the past, claimed_by some dead worker.
  const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  inspect
    .update(outboxEvents)
    .set({
      status: 'processing',
      claimedAt: longAgo,
      claimedBy: 'dead-worker-1',
    })
    .where(eq(outboxEvents.id, result.outboxEventId))
    .run();

  const report = await claimer.tick({
    workerInstanceId: 'live-worker-2',
    stuckTimeoutMs: 60_000,
  });
  assert.equal(report.claimed, 1, 'live worker should re-claim the stuck event');
  assert.equal(report.completed, 1);

  const afterTick = inspect
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, result.outboxEventId))
    .get();
  assert.equal(afterTick?.status, 'completed');
  assert.equal(afterTick?.claimedBy, 'live-worker-2');

  const sent = transport
    .list()
    .filter((e) => e.to === 'crash.recovery@acme.test');
  assert.equal(sent.length, 1, 'handler must be called exactly once');

  // Tick again — the now-completed row must not be re-claimed.
  const idleReport = await claimer.tick({
    workerInstanceId: 'live-worker-2',
    stuckTimeoutMs: 60_000,
  });
  assert.equal(idleReport.claimed, 0);
  assert.equal(
    transport.list().filter((e) => e.to === 'crash.recovery@acme.test')
      .length,
    1,
    'handler still called exactly once after the idle tick',
  );
});
