import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import { JobsClaimer } from '@nest-native/jobs';
import { drainJobs } from '@nest-native/jobs/testing';
import type { AppDatabase } from '../../src/database/database';
import { jobSchedules, jobs, outboxInbox } from '../../src/database/schema';
import {
  JOB_OUTBOX_INBOX_PRUNE,
  SCHEDULE_OUTBOX_INBOX_PRUNE,
} from '../../src/modules/outbox/inbox-prune.job';
import { seedDatabase } from '../../scripts/seed';

// The consumers' inbox is pruned by a nightly job on the jobs library's
// schedules, since @nestjs/outbox never prunes it: the schedule declared at
// bootstrap, and an occurrence deleting the records older than 30 days.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-inbox-prune-${process.pid}-${Date.now()}.db`,
);

const DAY_MS = 24 * 60 * 60 * 1_000;

let app: INestApplicationContext;
let claimer: JobsClaimer;
let db: AppDatabase;

const scheduleRow = () =>
  db
    .select()
    .from(jobSchedules)
    .where(eq(jobSchedules.name, SCHEDULE_OUTBOX_INBOX_PRUNE))
    .get();

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'inbox-prune-secret-at-least-32-characters-x';
  seedDatabase(dbPath);

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  // onApplicationBootstrap is what upserts the schedule row.
  await app.init();
  claimer = app.get(JobsClaimer);
  db = app.get<AppDatabase>(getDrizzleToken());
});

after(async () => {
  await app.close();
});

test('the nightly prune is declared at bootstrap, guarded against overlapping runs', () => {
  const schedule = scheduleRow();
  assert.ok(schedule, 'schedule row upserted at bootstrap');
  assert.equal(schedule.jobName, JOB_OUTBOX_INBOX_PRUNE);
  assert.equal(schedule.cron, '30 3 * * *');
  assert.equal(schedule.uniqueKey, SCHEDULE_OUTBOX_INBOX_PRUNE);
  assert.equal(schedule.enabled, true);
});

test('when it comes due, records older than 30 days go and newer ones stay', async () => {
  const now = Date.now();
  db.insert(outboxInbox)
    .values([
      { consumer: 'activity-feed', messageId: 'seen-31-days-ago', processedAt: now - 31 * DAY_MS },
      { consumer: 'invite-email', messageId: 'seen-40-days-ago', processedAt: now - 40 * DAY_MS },
      { consumer: 'activity-feed', messageId: 'seen-29-days-ago', processedAt: now - 29 * DAY_MS },
      { consumer: 'activity-feed', messageId: 'seen-today', processedAt: now },
    ])
    .run();

  // As if its cron time had passed: the claimer enqueues the occurrence itself.
  db.update(jobSchedules)
    .set({ nextRunAt: '2020-01-01T00:00:00.000Z' })
    .where(eq(jobSchedules.name, SCHEDULE_OUTBOX_INBOX_PRUNE))
    .run();
  await drainJobs(claimer);

  const [occurrence] = db
    .select()
    .from(jobs)
    .where(eq(jobs.name, JOB_OUTBOX_INBOX_PRUNE))
    .all();
  assert.equal(occurrence?.status, 'completed');
  assert.deepEqual(
    db
      .select({ messageId: outboxInbox.messageId })
      .from(outboxInbox)
      .all()
      .map((row) => row.messageId)
      .sort(),
    ['seen-29-days-ago', 'seen-today'],
  );
});
