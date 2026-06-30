import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import type { AppDatabase } from '../../src/database/database';
import { outboxEvents } from '../../src/database/schema';
import { OutboxClaimer, runWorkerLoop } from '@nest-native/messaging';
import { OrganizationOnboardingService } from '../../src/modules/onboarding/organization-onboarding.service';
import { FakeEmailTransport } from '../../src/modules/outbox/fake-email-transport.service';
import { seedDatabase } from '../../scripts/seed';

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-worker-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let onboarding: OrganizationOnboardingService;
let claimer: OutboxClaimer;
let transport: FakeEmailTransport;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'worker-test-secret-must-be-at-least-32-chars-x';
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  onboarding = app.get(OrganizationOnboardingService);
  claimer = app.get(OutboxClaimer);
  transport = app.get(FakeEmailTransport);
  inspect = app.get<AppDatabase>(getDrizzleClientToken());
});

after(async () => {
  await app.close();
});

test('worker loop drains pending outbox events on a fast tick interval', async () => {
  transport.reset();

  const invited = await onboarding.inviteUser({
    orgId: seededOrgId,
    invitedByUserId: seededAdminId,
    email: 'worker.drain@acme.test',
    projectName: 'Worker Drain Project',
    initialPassword: 'worker-pass-1234',
  });

  const controller = new AbortController();
  const loop = runWorkerLoop(claimer, {
    pollIntervalMs: 25,
    claimer: { workerInstanceId: 'worker-drain', stuckTimeoutMs: 60_000 },
    signal: controller.signal,
  });

  // Poll the DB until the event flips to completed, capped at ~1s.
  let row = inspect
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, invited.outboxEventId))
    .get();
  for (let i = 0; i < 40 && row?.status !== 'completed'; i += 1) {
    await delay(25);
    row = inspect
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, invited.outboxEventId))
      .get();
  }

  controller.abort();
  await loop;

  assert.equal(row?.status, 'completed');
  assert.equal(row?.claimedBy, 'worker-drain');
  const sent = transport
    .list()
    .filter((e) => e.to === 'worker.drain@acme.test');
  assert.equal(sent.length, 1);
});

test('worker loop exits promptly when the signal aborts mid-wait', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const loop = runWorkerLoop(claimer, {
    pollIntervalMs: 30_000,
    claimer: { workerInstanceId: 'worker-abort', stuckTimeoutMs: 60_000 },
    signal: controller.signal,
  });

  // Give the loop a moment to enter its delay() phase, then abort.
  await delay(50);
  controller.abort();
  await loop;

  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 5_000,
    `loop should exit immediately on abort, took ${elapsed}ms`,
  );
});

test('worker loop survives a tick error and keeps polling', async () => {
  transport.reset();

  const originalTick = claimer.tick.bind(claimer);
  let calls = 0;
  claimer.tick = (async (overrides) => {
    calls += 1;
    if (calls === 1) {
      throw new Error('synthetic tick failure');
    }
    return originalTick(overrides);
  }) as typeof claimer.tick;

  try {
    const controller = new AbortController();
    const loop = runWorkerLoop(claimer, {
      pollIntervalMs: 25,
      claimer: { workerInstanceId: 'worker-resilient' },
      signal: controller.signal,
    });

    // Let the loop attempt at least one failing tick + one successful tick.
    await delay(150);
    controller.abort();
    await loop;

    assert.ok(calls >= 2, `loop should keep polling after a failure, calls=${calls}`);
  } finally {
    claimer.tick = originalTick;
  }
});
