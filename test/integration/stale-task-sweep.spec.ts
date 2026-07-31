import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { JobSchedulesService, JobsClaimer } from '@nest-native/jobs';
import type { SqliteScheduleStore } from '@nest-native/jobs/sqlite';
import type { AppDatabase } from '../../src/database/database';
import {
  auditEvents,
  jobSchedules,
  jobs,
  tasks,
} from '../../src/database/schema';
import {
  AUDIT_ACTION_TASK_STALE_FLAGGED,
  JOB_STALE_TASK_SWEEP,
  SCHEDULE_STALE_TASK_SWEEP,
  STALE_TASK_AFTER_DAYS,
} from '../../src/modules/reminders/reminders.constants';
import { seedDatabase } from '../../scripts/seed';

// The recurring half of @nest-native/jobs, dogfooded: a job_schedules row
// declared at bootstrap, fired by the claimer itself (nobody enqueues it), with
// the misfire and overlap semantics the library promises.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-stale-sweep-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let claimer: JobsClaimer;
let schedules: JobSchedulesService<SqliteScheduleStore>;
let db: AppDatabase;
let orgId: number;
let adminId: number;
let projectId: number;
let staleTaskId: number;

const PAST = '2020-01-01T00:00:00.000Z';

const scheduleRow = () =>
  db
    .select()
    .from(jobSchedules)
    .where(eq(jobSchedules.name, SCHEDULE_STALE_TASK_SWEEP))
    .get()!;

const sweepJobs = () =>
  db.select().from(jobs).where(eq(jobs.name, JOB_STALE_TASK_SWEEP)).all();

const flagged = (taskId: number) =>
  db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, AUDIT_ACTION_TASK_STALE_FLAGGED),
        eq(auditEvents.subjectId, String(taskId)),
      ),
    )
    .all();

/** Makes the schedule due right now, the way a passed cron time would. */
const makeDue = () =>
  db
    .update(jobSchedules)
    .set({ nextRunAt: PAST })
    .where(eq(jobSchedules.name, SCHEDULE_STALE_TASK_SWEEP))
    .run();

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'stale-task-sweep-secret-at-least-32-chars-xx';
  const seeded = seedDatabase(dbPath);
  orgId = seeded.org.id;
  adminId = seeded.admin.id;
  projectId = seeded.project.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  // onApplicationBootstrap is what upserts the schedule row.
  await app.init();
  claimer = app.get(JobsClaimer);
  schedules = app.get(JobSchedulesService);
  db = app.get<AppDatabase>(getDrizzleClientToken());

  const old = new Date(
    Date.now() - (STALE_TASK_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000,
  ).toISOString();
  staleTaskId = db
    .insert(tasks)
    .values({
      orgId,
      projectId,
      title: 'Long-forgotten task',
      status: 'open',
      createdBy: adminId,
      createdAt: old,
    })
    .returning()
    .get().id;
  // A fresh open task and an old-but-done task must both be left alone.
  db.insert(tasks)
    .values({
      orgId,
      projectId,
      title: 'Fresh task',
      status: 'open',
      createdBy: adminId,
      createdAt: new Date().toISOString(),
    })
    .run();
  db.insert(tasks)
    .values({
      orgId,
      projectId,
      title: 'Old but finished',
      status: 'done',
      createdBy: adminId,
      createdAt: old,
    })
    .run();
});

after(async () => {
  await app.close();
});

test('bootstrap declares the sweep schedule, armed in the future and enqueuing nothing yet', async () => {
  const row = scheduleRow();
  assert.equal(row.jobName, JOB_STALE_TASK_SWEEP);
  assert.equal(row.cron, '0 3 * * *');
  assert.equal(row.enabled, true);
  assert.ok(
    (row.nextRunAt as string) > new Date().toISOString(),
    'armed for a future occurrence',
  );

  // Not due yet: a tick must not fire it.
  const report = await claimer.tick();
  assert.equal(report.scheduled, 0);
  assert.equal(sweepJobs().length, 0);
});

test('when due, the claimer enqueues AND runs the occurrence in one tick, flagging only stale open tasks', async () => {
  makeDue();

  const report = await claimer.tick();
  assert.equal(report.scheduled, 1, 'the schedule fired');
  assert.equal(report.claimed, 1, 'the occurrence was claimable in the same tick');
  assert.equal(report.completed, 1);

  // Exactly the one stale open task is flagged.
  assert.equal(flagged(staleTaskId).length, 1);
  const all = db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, AUDIT_ACTION_TASK_STALE_FLAGGED))
    .all();
  assert.equal(all.length, 1, 'fresh and completed tasks are left alone');
  assert.equal(all[0].orgId, orgId);

  // The schedule advanced to a future occurrence and stayed enabled.
  const row = scheduleRow();
  assert.ok((row.nextRunAt as string) > new Date().toISOString());
  assert.equal(row.enabled, true);
  assert.ok(row.lastEnqueuedAt !== null);
});

test('a redeploy-style boot upsert preserves a pending catch-up and an operator disable', async () => {
  // Operator turns the sweep off at runtime…
  await schedules.setEnabled(SCHEDULE_STALE_TASK_SWEEP, false);
  assert.equal(scheduleRow().enabled, false);

  // …and the next deploy re-runs the identical bootstrap upsert.
  app.get(
    (await import('../../src/modules/reminders/stale-task-schedule.setup'))
      .StaleTaskScheduleSetup,
  ).onApplicationBootstrap();

  assert.equal(
    scheduleRow().enabled,
    false,
    'the operator disable survives a redeploy (omitted enabled preserves the stored flag)',
  );

  // Re-enable, make it due, then re-run the boot upsert: the pending catch-up
  // must survive because the cron is unchanged.
  await schedules.setEnabled(SCHEDULE_STALE_TASK_SWEEP, true);
  makeDue();
  app.get(
    (await import('../../src/modules/reminders/stale-task-schedule.setup'))
      .StaleTaskScheduleSetup,
  ).onApplicationBootstrap();
  assert.equal(
    scheduleRow().nextRunAt,
    PAST,
    'still due — the boot upsert did not skip the pending occurrence',
  );
});

test('the uniqueKey overlap guard stops occurrences stacking while one is active', async () => {
  makeDue();
  const first = await claimer.tick();
  assert.equal(first.scheduled, 1);
  const occurrences = sweepJobs().length;

  // Simulate "the previous run is still going": re-arm the occurrence the tick
  // just completed as an ACTIVE job that still holds the schedule's uniqueKey.
  // Restoring the key matters — a terminal transition clears it (that is what
  // scopes dedup to active jobs), so a resurrected row without it would not
  // guard anything. availableAt in the future keeps the claimer's hands off it.
  const all = sweepJobs();
  const done = all[all.length - 1];
  db.update(jobs)
    .set({
      status: 'pending',
      uniqueKey: SCHEDULE_STALE_TASK_SWEEP,
      availableAt: '2999-01-01T00:00:00.000Z',
    })
    .where(eq(jobs.id, done.id))
    .run();

  makeDue();
  const second = await claimer.tick();

  assert.equal(second.scheduled, 1, 'the schedule still advances');
  assert.equal(
    sweepJobs().length,
    occurrences,
    'no new occurrence while one with the same uniqueKey is active',
  );
});
