import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { ContextIdFactory, NestFactory } from '@nestjs/core';
import { OrganizationOnboardingService } from '../../src/modules/onboarding/organization-onboarding.service';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { seedDatabase } from '../../scripts/seed';

// The API and the worker are two processes on one SQLite file, and the worker
// writes whenever it delivers a message or runs a job. Each producer below reads
// before its first write (the project, the membership, the invitee's email). A
// deferred transaction that has read cannot wait for the write lock: SQLite
// fails its upgrade at once, with SQLITE_BUSY while the other process holds the
// lock and with SQLITE_BUSY_SNAPSHOT once that one has committed. So the
// producers open with BEGIN IMMEDIATE, which waits like any writer. A child
// process plays the worker: it takes the write lock with BEGIN IMMEDIATE, says
// so, holds it for HOLD_MS and commits.
const HOLD_MS = 300;

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-producers-cross-process-${process.pid}-${Date.now()}.db`,
);

const WORKER = `
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { timeout: 5000 });
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${HOLD_MS});
`;

let app: INestApplicationContext;
let tasksService: TasksService;
let onboarding: OrganizationOnboardingService;
let seededOrgId: number;
let seededAdminId: number;
let seededProjectId: number;

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'producers-cross-process-secret-32-chars-xx';
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
  onboarding = app.get(OrganizationOnboardingService);

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

/**
 * Runs `call` while the other process holds the write lock, and says how long
 * it took. The child is awaited whatever `call` does, so a producer that fails
 * fast does not leave it holding the lock for the next case.
 */
async function whileTheWorkerWrites<T>(
  call: () => Promise<T>,
): Promise<{ result: T; waited: number }> {
  const child = spawn(process.execPath, ['-e', WORKER, dbPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`the worker exited (${code}) before it held the lock`)),
      );
    });
    const started = Date.now();
    const result = await call();
    return { result, waited: Date.now() - started };
  } finally {
    await exited;
  }
}

const assertWaited = (waited: number) =>
  assert.ok(waited >= HOLD_MS - 50, `the producer waited ${waited} ms for the lock`);

test('createTask waits for the write lock, then commits', async () => {
  const { result, waited } = await whileTheWorkerWrites(() =>
    tasksService.createTask({ projectId: seededProjectId, title: 'Wait for the worker' }),
  );
  assert.equal(result.title, 'Wait for the worker');
  assertWaited(waited);
});

test('assignTask waits for the write lock, then commits', async () => {
  const task = await tasksService.createTask({
    projectId: seededProjectId,
    title: 'Assign it while the worker writes',
  });

  const assigned = await whileTheWorkerWrites(() =>
    tasksService.assignTask({ id: task.id, assigneeId: seededAdminId }),
  );
  assert.equal(assigned.result.assigneeId, seededAdminId);
  assertWaited(assigned.waited);
});

test('inviteUser waits for the write lock, then commits', async () => {
  const { result, waited } = await whileTheWorkerWrites(() =>
    onboarding.inviteUser({
      orgId: seededOrgId,
      invitedByUserId: seededAdminId,
      email: 'invitee.waits@acme.test',
      projectName: 'Invited While The Worker Writes',
      initialPassword: 'temp-pass-12345',
    }),
  );
  assert.equal(result.user.email, 'invitee.waits@acme.test');
  assertWaited(waited);
});
