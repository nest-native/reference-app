import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import type { INestApplicationContext, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import type { AppDatabase } from '../../src/database/database';
import { outboxMessages } from '../../src/database/schema';
import { OrganizationOnboardingService } from '../../src/modules/onboarding/organization-onboarding.service';
import { FakeEmailTransport } from '../../src/modules/outbox/fake-email-transport.service';
import { SqliteOutboxStore } from '../../src/modules/outbox/sqlite-outbox.store';
import { seedDatabase } from '../../scripts/seed';

// The relay as the worker runs it: started, polling on its own timer, and
// stopped. AppModule boots it disabled in every process; scripts/start-worker.ts
// calls start(), and app.close() stops it.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-relay-${process.pid}-${Date.now()}.db`,
);

/** Keeps what the app logged at error level, to see the relay report a failure. */
class RecordingLogger implements LoggerService {
  readonly errors: string[] = [];
  log(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
  error(message: unknown): void {
    this.errors.push(String(message));
  }
}

const logger = new RecordingLogger();
let app: INestApplicationContext;
let closed = false;
let onboarding: OrganizationOnboardingService;
let relay: OutboxRelay;
let transport: FakeEmailTransport;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'relay-test-secret-must-be-at-least-32-chars-xx';
  // Read when AppModule loads: a fast poll, so the started relay drains quickly.
  process.env.OUTBOX_POLL_MS = '25';
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger,
    // Surface boot failures: Nest otherwise process.exit(1)s.
    abortOnError: false,
  });
  onboarding = app.get(OrganizationOnboardingService);
  relay = app.get(OutboxRelay);
  transport = app.get(FakeEmailTransport);
  inspect = app.get<AppDatabase>(getDrizzleToken());
});

after(async () => {
  if (!closed) await app.close();
});

const invite = (email: string) =>
  onboarding.inviteUser({
    orgId: seededOrgId,
    invitedByUserId: seededAdminId,
    email,
    projectName: `Project for ${email}`,
    initialPassword: 'relay-pass-12345',
  });

const pending = (id: string) =>
  inspect.select().from(outboxMessages).where(eq(outboxMessages.id, id)).get();

/** Waits (about 2 s at most) for the relay to publish the message, which deletes its row. */
async function untilPublished(id: string): Promise<void> {
  for (let i = 0; i < 80 && pending(id); i += 1) {
    await delay(25);
  }
}

const emailsTo = (email: string) =>
  transport.list().filter((sent) => sent.to === email);

test('a started relay drains a committed invite on its own timer, and stops promptly', async () => {
  const invited = await invite('relay.drain@acme.test');
  assert.equal(relay.running, false, 'AppModule never starts the relay');

  relay.start();
  await untilPublished(invited.outboxEventId);
  const stopping = Date.now();
  await relay.stop();

  assert.ok(Date.now() - stopping < 1_000, 'stop() does not wait for the next poll');
  assert.equal(relay.running, false);
  assert.equal(pending(invited.outboxEventId), undefined, 'published, so deleted');
  assert.equal(emailsTo('relay.drain@acme.test').length, 1);
});

test('a claim that fails is logged, and the relay keeps polling and publishes', async () => {
  const store = app.get(SqliteOutboxStore);
  const claim = store.claim.bind(store);
  let calls = 0;
  store.claim = (request) => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic claim failure');
    return claim(request);
  };

  try {
    const invited = await invite('relay.resilient@acme.test');
    relay.start();
    await untilPublished(invited.outboxEventId);
    await relay.stop();

    assert.ok(calls >= 2, `the relay polled again after the failure, calls=${calls}`);
    assert.ok(
      logger.errors.some((line) => line.includes('synthetic claim failure')),
      'the failed claim was logged',
    );
    assert.equal(pending(invited.outboxEventId), undefined);
    assert.equal(emailsTo('relay.resilient@acme.test').length, 1);
  } finally {
    store.claim = claim;
  }
});

test('closing the app stops a running relay', async () => {
  relay.start();
  assert.equal(relay.running, true);

  await app.close();
  closed = true;

  assert.equal(relay.running, false);
});
