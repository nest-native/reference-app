import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { ContextIdFactory, NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Outbox, OutboxRelay } from '@nestjs/outbox';
import { JobsClaimer, JobsService } from '@nest-native/jobs';
import type { SqliteJobStore } from '@nest-native/jobs/sqlite';
import { drainJobs } from '@nest-native/jobs/testing';
import type { AppDatabase } from '../../src/database/database';
import { auditEvents, jobs } from '../../src/database/schema';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import {
  AUDIT_ACTION_TASK_REMINDER_SENT,
  JOB_TASK_ASSIGNMENT_REMINDER,
} from '../../src/modules/reminders/reminders.constants';
import { seedDatabase } from '../../scripts/seed';

// The deferred assignment-reminder: assigning a task must schedule EXACTLY ONE
// reminder job — transactionally with the activity projection, immune to event
// redelivery (two independent dedup layers), executed exactly once when due.
const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-assignment-reminder-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let tasksService: TasksService;
let relay: OutboxRelay;
let outbox: Outbox<AppDatabase>;
let jobsClaimer: JobsClaimer;
let jobsService: JobsService<SqliteJobStore>;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;
let seededProjectId: number;
let taskId: number;
let assignedPayload: Record<string, unknown>;

const reminderJobs = () =>
  inspect
    .select()
    .from(jobs)
    .where(eq(jobs.name, JOB_TASK_ASSIGNMENT_REMINDER))
    .all();

const reminderAudits = () =>
  inspect
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, AUDIT_ACTION_TASK_REMINDER_SENT),
        eq(auditEvents.subjectId, String(taskId)),
      ),
    )
    .all();

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'assignment-reminder-secret-at-least-32-chars-x';
  // 0 = the reminder is due as soon as the jobs claimer looks (the jobs
  // library's delayMs contract) — the spec drives time by draining, not waiting.
  process.env.TASK_REMINDER_DELAY_MS = '0';
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;
  seededProjectId = seeded.project.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  relay = app.get(OutboxRelay);
  outbox = app.get<Outbox<AppDatabase>>(Outbox);
  jobsClaimer = app.get(JobsClaimer);
  jobsService = app.get(JobsService);
  inspect = app.get<AppDatabase>(getDrizzleToken());

  const contextId = ContextIdFactory.create();
  app.registerRequestByContextId(
    {
      authContext: {
        user: { id: seededAdminId },
        organization: { id: seededOrgId },
      },
    },
    contextId,
  );
  tasksService = await app.resolve(TasksService, contextId);
});

after(async () => {
  await app.close();
});

test('assigning a task schedules exactly one pending reminder job with the event dedup key', async () => {
  const created = await tasksService.createTask({
    projectId: seededProjectId,
    title: 'Wire the assignment reminder',
  });
  taskId = created.id;
  await tasksService.assignTask({ id: taskId, assigneeId: seededAdminId });

  // No job before the events are delivered — the reminder is scheduled by the
  // projection (delivery-side), not by the command.
  assert.equal(reminderJobs().length, 0);

  // Deliver the committed events (task.created + task.assigned) in-process.
  const report = await relay.runOnce();
  assert.ok(report.published >= 2, 'both lifecycle events delivered');

  const rows = reminderJobs();
  assert.equal(rows.length, 1, 'exactly one reminder job scheduled');
  const job = rows[0]!;
  assignedPayload = job.payload as Record<string, unknown>;
  assert.equal(job.status, 'pending');
  assert.equal(
    job.uniqueKey,
    `task.assigned:${seededOrgId}:${taskId}:${seededAdminId}`,
    'job uniqueKey is the activity dedup key',
  );
  assert.equal(assignedPayload.taskId, taskId);
  assert.equal(assignedPayload.assigneeId, seededAdminId);
});

test('redelivering the task.assigned event never schedules a second reminder (feed dedup)', async () => {
  // The same event again under a new message id, which the handler's inbox has
  // not seen, so the projection runs: it sees the duplicate feed row and skips
  // the enqueue entirely.
  inspect.transaction(() =>
    outbox.add(inspect, {
      topic: 'task.assigned',
      payload: assignedPayload,
      headers: {
        'x-idempotency-key': `task.assigned:${seededOrgId}:${taskId}:redelivery`,
      },
    }),
  );
  const report = await relay.runOnce();
  assert.equal(report.published, 1, 'the redelivery was delivered');
  assert.equal(reminderJobs().length, 1, 'still exactly one reminder job');
});

test('a duplicate enqueue with the same uniqueKey is a no-op returning the existing row (jobs dedup)', () => {
  const existing = reminderJobs()[0]!;
  const returned = jobsService.enqueue({
    name: JOB_TASK_ASSIGNMENT_REMINDER,
    payload: assignedPayload,
    uniqueKey: existing.uniqueKey!,
  });
  assert.equal(returned.id, existing.id, 'existing active job returned');
  assert.equal(reminderJobs().length, 1);
});

test('the due reminder fires exactly once and releases its unique key', async () => {
  const report = await drainJobs(jobsClaimer);
  assert.ok(report.completed >= 1, 'the reminder job ran');

  const audits = reminderAudits();
  assert.equal(audits.length, 1, 'exactly one reminder audit entry');
  const metadata = audits[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.assigneeId, seededAdminId);
  assert.ok(metadata.jobId, 'audit entry carries the job id');

  const job = reminderJobs()[0]!;
  assert.equal(job.status, 'completed');
  assert.equal(job.uniqueKey, null, 'terminal job released its unique key');

  // Draining again is a no-op — the side effect ran exactly once.
  const second = await drainJobs(jobsClaimer);
  assert.equal(second.claimed, 0);
  assert.equal(reminderAudits().length, 1);
});

test('a malformed reminder payload fails permanently without an audit entry', async () => {
  jobsService.enqueue({
    name: JOB_TASK_ASSIGNMENT_REMINDER,
    payload: { not: 'a task.assigned payload' },
  });
  const report = await drainJobs(jobsClaimer);
  assert.equal(report.failed, 1, 'PermanentError fails the job immediately');
  assert.equal(reminderAudits().length, 1, 'no additional reminder audit');
  const failed = reminderJobs().find((j) => j.status === 'failed');
  assert.match(failed?.lastError ?? '', /malformed payload/);
});
