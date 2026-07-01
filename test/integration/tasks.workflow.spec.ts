import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { ContextIdFactory, NestFactory } from '@nestjs/core';
import { and, eq, inArray } from 'drizzle-orm';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { OutboxClaimer } from '@nest-native/messaging';
import type { AppDatabase } from '../../src/database/database';
import { activityEvents, outboxEvents, tasks } from '../../src/database/schema';
import { ActivityService } from '../../src/modules/activity/activity.service';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { seedDatabase } from '../../scripts/seed';

const TASK_TOPICS = ['task.created', 'task.assigned', 'task.completed'];

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-tasks-workflow-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let tasksService: TasksService;
let activity: ActivityService;
let claimer: OutboxClaimer;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;
let seededProjectId: number;
let taskId: number;

const taskOutboxRows = () =>
  inspect
    .select()
    .from(outboxEvents)
    .where(inArray(outboxEvents.topic, TASK_TOPICS))
    .all();

const feedRows = () =>
  inspect
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.projectId, seededProjectId))
    .all();

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'tasks-workflow-secret-at-least-32-chars-xxxxx';
  const seeded = seedDatabase(dbPath);
  seededOrgId = seeded.org.id;
  seededAdminId = seeded.admin.id;
  seededProjectId = seeded.project.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  claimer = app.get(OutboxClaimer);
  activity = app.get(ActivityService);
  inspect = app.get<AppDatabase>(getDrizzleClientToken());

  // TasksService reads CURRENT_ORGANIZATION / CURRENT_USER (request-scoped), so
  // resolve it against a registered request that carries the seeded tenant —
  // the application-context equivalent of an authenticated tRPC call.
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

test('create → assign → complete writes the task rows and enqueues 3 lifecycle events', async () => {
  const created = await tasksService.createTask({
    projectId: seededProjectId,
    title: 'Ship the activity feed',
  });
  taskId = created.id;
  assert.equal(created.orgId, seededOrgId);
  assert.equal(created.projectId, seededProjectId);
  assert.equal(created.status, 'open');
  assert.equal(created.assigneeId, null);
  assert.equal(created.createdBy, seededAdminId);

  const assigned = await tasksService.assignTask({
    id: taskId,
    assigneeId: seededAdminId,
  });
  assert.equal(assigned.status, 'in_progress');
  assert.equal(assigned.assigneeId, seededAdminId);

  const completed = await tasksService.completeTask(taskId);
  assert.equal(completed.status, 'done');

  // The persisted row reflects the terminal state.
  const row = inspect
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, seededOrgId)))
    .get();
  assert.equal(row?.status, 'done');
  assert.equal(row?.assigneeId, seededAdminId);

  // One outbox event per lifecycle step, all pending, all with scoped keys.
  const enqueued = taskOutboxRows();
  assert.equal(enqueued.length, 3);
  assert.deepEqual(
    enqueued.map((e) => e.topic).sort(),
    ['task.assigned', 'task.completed', 'task.created'],
  );
  for (const e of enqueued) {
    assert.equal(e.status, 'pending');
    assert.ok(e.idempotencyKey?.startsWith(`${e.topic}:${seededOrgId}:`));
  }

  // Feed is still empty — it is only fed by the claimer, never the service.
  assert.equal(feedRows().length, 0);
});

test('claimer drains the events into the activity feed — one row per event', async () => {
  const report = await claimer.tick();
  assert.equal(report.claimed, 3);
  assert.equal(report.completed, 3);

  const drained = taskOutboxRows();
  for (const e of drained) {
    assert.equal(e.status, 'completed');
    assert.ok(e.processedAt);
  }

  const feed = feedRows();
  assert.equal(feed.length, 3);
  assert.deepEqual(
    feed.map((r) => r.type).sort(),
    ['task.assigned', 'task.completed', 'task.created'],
  );
  for (const r of feed) {
    assert.equal(r.orgId, seededOrgId);
    assert.ok(r.summary.length > 0);
    assert.ok(r.dedupKey.length > 0);
  }

  // The org-scoped reader the activity router uses returns the same 3 rows.
  const viaReader = activity.list(seededOrgId, seededProjectId);
  assert.equal(viaReader.length, 3);
});

test('redelivery is idempotent: re-ticking the same events adds no feed rows', async () => {
  // Simulate an at-least-once redelivery: reset the completed outbox rows to
  // pending so the claimer re-runs the in-process handler for each event.
  inspect
    .update(outboxEvents)
    .set({
      status: 'pending',
      attempts: 0,
      claimedAt: null,
      claimedBy: null,
      processedAt: null,
      lastError: null,
      availableAt: new Date(0).toISOString(),
    })
    .where(inArray(outboxEvents.topic, TASK_TOPICS))
    .run();

  const report = await claimer.tick();
  // The handler DID run again for all three (they were re-claimed + completed)…
  assert.equal(report.claimed, 3);
  assert.equal(report.completed, 3);

  // …yet the (org_id, dedup_key) unique index kept the feed at exactly 3 rows.
  const feed = feedRows();
  assert.equal(feed.length, 3, 'redelivery must not duplicate feed rows');
});
