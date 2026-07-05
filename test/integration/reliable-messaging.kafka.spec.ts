import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';

// GATED end-to-end against a LIVE broker. Skipped unless KAFKA_BROKERS is set,
// so it never runs in plain CI. To run it locally:
//
//   npm run infra:up      # compose `redpanda` service (profile `kafka`), waits for health
//   npm run test:kafka    # this file, with KAFKA_BROKERS=localhost:19092 and
//                         # KAFKA_TOPIC_PREFIX=reliable-e2e. set for you
//   npm run infra:down    # removes the broker and its volume
//
// (`npm run test:full` chains the base suite and this file.)
//
// It exercises the full pair: a transactional enqueue → the claimer publishes to
// Kafka → the consumer deduplicates and writes ONE audit row → a forced
// redelivery proves the inbox keeps it at exactly one.
const LIVE = Boolean(process.env.KAFKA_BROKERS);

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-reliable-e2e-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let onboarding: import('../../src/modules/onboarding/organization-onboarding.service').OrganizationOnboardingService;
let claimer: import('@nest-native/messaging').OutboxClaimer;
let producer: import('@nest-native/kafka').KafkaProducerService;
let inspect: import('../../src/database/database').AppDatabase;
let schema: typeof import('../../src/database/schema');
let drizzleOps: typeof import('drizzle-orm');
let seededOrgId: number;
let seededAdminId: number;

const TOPIC_PREFIX = process.env.KAFKA_TOPIC_PREFIX ?? '';
const TOPIC = `${TOPIC_PREFIX}user.invited`;

before(async () => {
  if (!LIVE) return;
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'reliable-e2e-test-secret-min-32-characters-x';

  const { seedDatabase } = await import('../../scripts/seed');
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;

  schema = await import('../../src/database/schema');
  drizzleOps = await import('drizzle-orm');
  const { NestFactory } = await import('@nestjs/core');
  const { getDrizzleClientToken } = await import('@nest-native/drizzle');
  const { KafkaProducerService } = await import('@nest-native/kafka');
  const { OrganizationOnboardingService } = await import(
    '../../src/modules/onboarding/organization-onboarding.service'
  );
  const { OutboxClaimer } = await import('@nest-native/messaging');
  const { AppModule } = await import('../../src/app.module');

  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  onboarding = app.get(OrganizationOnboardingService);
  claimer = app.get(OutboxClaimer);
  producer = app.get(KafkaProducerService);
  inspect = app.get(getDrizzleClientToken());
});

after(async () => {
  if (!LIVE || !app) return;
  await app.close();
});

const deliveredAuditCount = (subjectId: string) =>
  inspect
    .select()
    .from(schema.auditEvents)
    .where(
      drizzleOps.and(
        drizzleOps.eq(schema.auditEvents.action, 'user.invited.delivered'),
        drizzleOps.eq(schema.auditEvents.subjectId, subjectId),
      ),
    )
    .all().length;

const inboxCount = (key: string) =>
  inspect
    .select()
    .from(schema.inboxEvents)
    .where(drizzleOps.eq(schema.inboxEvents.messageKey, key))
    .all().length;

// Publish-until-delivered. A fresh consumer group starts at `latest`, and
// joining + assignment on a fresh broker takes a few seconds — a record
// published right after `app.init()` (the claimer's) always lands *before*
// the consumer is assigned, so it is invisible to that group forever. Nudging
// with the same wire message is safe by design: the dedup key keeps the inbox
// exactly-once no matter how many copies land, which is exactly the property
// this suite exists to prove.
async function nudgeUntilDelivered(
  subjectId: string,
  republish: () => Promise<unknown>,
  capMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (deliveredAuditCount(subjectId) >= 1) return;
    await republish();
    await delay(1_000);
  }
}

test(
  'enqueue → claimer publishes to Kafka → consumer writes exactly one audit row, redelivery stays at one',
  { skip: !LIVE },
  async () => {
    const invited = await onboarding.inviteUser({
      orgId: seededOrgId,
      invitedByUserId: seededAdminId,
      email: 'reliable.e2e@acme.test',
      projectName: 'Reliable E2E Project',
      initialPassword: 'reliable-pass-1234',
    });
    const subjectId = String(invited.user.id);
    // The Kafka message key (and `x-idempotency-key` header) is the outbox
    // idempotency key…
    const dedupKey = `user.invited:${seededOrgId}:${invited.user.id}:${invited.project.id}`;
    // …but the inbox dedups on the wire contract's first hit, `x-event-id`
    // (the outbox row id), so that is the messageKey it stores.
    const inboxKey = invited.outboxEventId;

    // The same wire message the claimer publishes; used to nudge past the
    // group-assignment race and to force the redelivery below.
    const republish = () =>
      producer.send({
        topic: TOPIC,
        messages: [
          {
            key: dedupKey,
            value: JSON.stringify({
              invitedEmail: 'reliable.e2e@acme.test',
              invitedUserId: invited.user.id,
              invitedByUserId: seededAdminId,
              orgId: seededOrgId,
              projectId: invited.project.id,
            }),
            headers: { 'x-event-id': invited.outboxEventId, 'x-idempotency-key': dedupKey },
          },
        ],
      });

    // The claimer publishes the pending outbox row to Kafka.
    const report = await claimer.tick();
    assert.equal(report.claimed, 1);
    assert.equal(report.completed, 1);

    await nudgeUntilDelivered(subjectId, republish);
    assert.equal(deliveredAuditCount(subjectId), 1, 'consumer delivered once');
    assert.equal(inboxCount(inboxKey), 1, 'one inbox dedup row');

    // Force a redelivery by re-publishing the same message to the topic. The
    // inbox must deduplicate it: the audit row count and inbox row count stay 1.
    await republish();
    await delay(2_000);

    assert.equal(
      deliveredAuditCount(subjectId),
      1,
      'redelivery did NOT write a second audit row',
    );
    assert.equal(inboxCount(inboxKey), 1, 'still exactly one inbox row');
  },
);
