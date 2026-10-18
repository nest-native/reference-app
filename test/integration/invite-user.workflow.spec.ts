import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import type { AppDatabase } from '../../src/database/database';
import {
  auditEvents,
  memberships,
  outboxInbox,
  outboxMessages,
  projects,
  users,
} from '../../src/database/schema';
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
let relay: OutboxRelay;
let transport: FakeEmailTransport;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;

const countAll = () => ({
  users: inspect.select().from(users).all().length,
  memberships: inspect.select().from(memberships).all().length,
  projects: inspect.select().from(projects).all().length,
  auditEvents: inspect.select().from(auditEvents).all().length,
  outboxMessages: inspect.select().from(outboxMessages).all().length,
});

const messageRow = (id: string) =>
  inspect.select().from(outboxMessages).where(eq(outboxMessages.id, id)).get();

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
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  onboarding = app.get(OrganizationOnboardingService);
  projectsRepo = app.get(ProjectsRepository);
  relay = app.get(OutboxRelay);
  transport = app.get(FakeEmailTransport);
  inspect = app.get<AppDatabase>(getDrizzleToken());
});

after(async () => {
  await app.close();
});

test('happy path: inviteUser persists 5 rows; the relay delivers the email once; idempotency key set', async () => {
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
  assert.equal(after.outboxMessages, before.outboxMessages + 1);

  const message = messageRow(result.outboxEventId);
  assert.ok(message);
  assert.equal(message.topic, 'user.invited');
  assert.equal(message.leaseOwner, null, 'not claimed yet');
  const headers = JSON.parse(message.headers) as Record<string, string>;
  assert.ok(headers['x-idempotency-key']?.startsWith('user.invited:'));

  const report = await relay.runOnce();
  assert.equal(report.claimed, 1);
  assert.equal(report.published, 1);

  assert.equal(messageRow(result.outboxEventId), undefined, 'a published message is deleted');
  const inbox = inspect
    .select()
    .from(outboxInbox)
    .where(
      and(
        eq(outboxInbox.consumer, 'invite-email'),
        eq(outboxInbox.messageId, result.outboxEventId),
      ),
    )
    .all();
  assert.equal(inbox.length, 1, "the handler's inbox recorded the message");

  const sent = transport.list();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, 'invitee.happy@acme.test');
});

test('rollback safety: throw between steps 3 and 4 leaves no rows from this transaction', async () => {
  transport.reset();
  const before = countAll();

  // Override on the exact instance that OrganizationOnboardingService holds
  // — each module that lists ProjectsRepository in its providers gets its own
  // instance, so app.get(ProjectsRepository) may return a different instance
  // than onboarding's injected dep.
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

test('worker crash recovery: a lease that ran out is claimed again and processed once', async () => {
  transport.reset();

  const result = await onboarding.inviteUser({
    orgId: seededOrgId,
    invitedByUserId: seededAdminId,
    email: 'crash.recovery@acme.test',
    projectName: 'Crash Recovery Project',
    initialPassword: 'temp-pass-12345',
  });

  // A relay that claimed this message then died: its lease is still live, and
  // a live lease is never taken over.
  inspect
    .update(outboxMessages)
    .set({ leaseOwner: 'dead-relay', leaseUntil: Date.now() + 60_000 })
    .where(eq(outboxMessages.id, result.outboxEventId))
    .run();
  const whileLeased = await relay.runOnce();
  assert.equal(whileLeased.claimed, 0, 'a live lease is never taken over');

  // The dead relay's lease runs out: the next claim takes the message over.
  inspect
    .update(outboxMessages)
    .set({ leaseUntil: Date.now() - 1 })
    .where(eq(outboxMessages.id, result.outboxEventId))
    .run();
  const report = await relay.runOnce();
  assert.equal(report.claimed, 1, 'the relay claims the message back once its lease ran out');
  assert.equal(report.published, 1);
  assert.equal(messageRow(result.outboxEventId), undefined);

  const sent = transport
    .list()
    .filter((e) => e.to === 'crash.recovery@acme.test');
  assert.equal(sent.length, 1, 'handler must be called exactly once');

  // Run again — the published message is gone and must not come back.
  const idleReport = await relay.runOnce();
  assert.equal(idleReport.claimed, 0);
  assert.equal(
    transport.list().filter((e) => e.to === 'crash.recovery@acme.test')
      .length,
    1,
    'handler still called exactly once after the idle run',
  );
});
