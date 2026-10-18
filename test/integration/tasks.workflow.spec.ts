import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { ContextIdFactory, NestFactory } from '@nestjs/core';
import { and, eq, inArray } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import { type NewOutboxMessage, Outbox, OutboxRelay } from '@nestjs/outbox';
import type { AppDatabase } from '../../src/database/database';
import {
  activityEvents,
  outboxInbox,
  outboxMessages,
  tasks,
} from '../../src/database/schema';
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
let relay: OutboxRelay;
let outbox: Outbox<AppDatabase>;
let inspect: AppDatabase;
let seededOrgId: number;
let seededAdminId: number;
let seededProjectId: number;
let taskId: number;
// The three messages as they were added, for the redelivery test: a published
// message's row is deleted.
let published: NewOutboxMessage[] = [];

const taskOutboxRows = () =>
  inspect
    .select()
    .from(outboxMessages)
    .where(inArray(outboxMessages.topic, TASK_TOPICS))
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
    // Surface boot failures: Nest otherwise process.exit(1)s and
    // { logger: false } hides why.
    abortOnError: false,
  });
  relay = app.get(OutboxRelay);
  outbox = app.get<Outbox<AppDatabase>>(Outbox);
  activity = app.get(ActivityService);
  inspect = app.get<AppDatabase>(getDrizzleToken());

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

test('create → assign → complete writes the task rows and adds 3 lifecycle messages', async () => {
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

  // One outbox message per lifecycle step, none claimed yet, all with scoped keys.
  const added = taskOutboxRows();
  assert.equal(added.length, 3);
  assert.deepEqual(
    added.map((m) => m.topic).sort(),
    ['task.assigned', 'task.completed', 'task.created'],
  );
  for (const m of added) {
    assert.equal(m.leaseOwner, null);
    const headers = JSON.parse(m.headers) as Record<string, string>;
    assert.ok(headers['x-idempotency-key']?.startsWith(`${m.topic}:${seededOrgId}:`));
  }
  published = added.map((m) => ({
    id: m.id,
    topic: m.topic,
    payload: JSON.parse(m.payload as string),
    headers: JSON.parse(m.headers) as Record<string, string>,
  }));

  // Feed is still empty — it is only fed by the relay, never the service.
  assert.equal(feedRows().length, 0);
});

test('the relay drains the messages into the activity feed — one row per message', async () => {
  const report = await relay.runOnce();
  assert.equal(report.claimed, 3);
  assert.equal(report.published, 3);

  assert.equal(taskOutboxRows().length, 0, 'published messages are deleted');

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

test('redelivery is idempotent: the same messages again add no feed rows', async () => {
  // An at-least-once redelivery: the same three messages, same ids, added
  // again (a published message's row is gone), so the relay delivers them to
  // the in-process handler a second time.
  inspect.transaction(() => outbox.add(inspect, published));

  const report = await relay.runOnce();
  // The relay DID deliver all three again…
  assert.equal(report.claimed, 3);
  assert.equal(report.published, 3);

  // …yet the handler's inbox skipped them: still exactly 3 feed rows, and one
  // inbox record per message.
  const feed = feedRows();
  assert.equal(feed.length, 3, 'redelivery must not duplicate feed rows');
  const inbox = inspect
    .select()
    .from(outboxInbox)
    .where(
      and(
        eq(outboxInbox.consumer, 'activity-feed'),
        inArray(
          outboxInbox.messageId,
          published.map((m) => m.id as string),
        ),
      ),
    )
    .all();
  assert.equal(inbox.length, 3);
});
