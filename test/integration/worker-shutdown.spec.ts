import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { jobs, outboxMessages, schema } from '../../src/database/schema';
import { seedDatabase, type SeedResult } from '../../scripts/seed';

// The worker as `npm run start:worker` runs it, in a child process. A SIGTERM
// stops both of its loops. The jobs loop returns only once its current tick
// does, which a long job stretches; the relay has to stop claiming at the
// signal, not when that job ends. The child preloads test/fixtures/
// slow-reminder.ts, which makes the assignment reminder a job that runs for
// SLOW_JOB_MS.
const SLOW_JOB_MS = 1_500;

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-worker-shutdown-${process.pid}-${Date.now()}.db`,
);

let seeded: SeedResult;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  seeded = seedDatabase(dbPath);
  sqlite = new Database(dbPath, { timeout: 5_000 });
  sqlite.pragma('journal_mode = WAL');
  db = drizzle(sqlite, { schema });
});

after(() => {
  sqlite.close();
});

function startWorker(): { worker: ChildProcess; output: () => string } {
  const worker = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './test/fixtures/slow-reminder.ts',
      'scripts/start-worker.ts',
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: dbPath,
        AUTH_SECRET: 'worker-shutdown-secret-at-least-32-chars-x',
        OUTBOX_POLL_MS: '50',
        SLOW_JOB_MS: String(SLOW_JOB_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  worker.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  worker.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { worker, output: () => output };
}

/** Waits (10 s at most) until the worker has printed `pattern`. */
async function until(output: () => string, pattern: RegExp): Promise<void> {
  for (let i = 0; i < 400 && !pattern.test(output()); i += 1) {
    await delay(25);
  }
  assert.match(output(), pattern);
}

test('a SIGTERM stops the relay at once, while the jobs loop finishes its long job', async () => {
  const { worker, output } = startWorker();
  const exited = once(worker, 'exit');
  await until(output, /worker started/);

  const now = new Date().toISOString();
  const jobId = randomUUID();
  db.insert(jobs)
    .values({
      id: jobId,
      name: 'task.assignment-reminder',
      payload: {
        taskId: 1,
        orgId: seeded.org.id,
        projectId: seeded.project.id,
        assigneeId: seeded.admin.id,
        assignedBy: seeded.admin.id,
      },
      status: 'pending',
      availableAt: now,
      createdAt: now,
    })
    .run();
  await until(output, /slow job running/);

  worker.kill('SIGTERM');
  await until(output, /received SIGTERM/);
  // Added while the jobs loop is still busy: a relay still polling every
  // 50 ms would publish it long before the job ends.
  const lateId = randomUUID();
  db.insert(outboxMessages)
    .values({
      id: lateId,
      topic: 'user.invited',
      payload: JSON.stringify({
        invitedEmail: 'late@acme.test',
        invitedUserId: seeded.admin.id,
        invitedByUserId: seeded.admin.id,
        orgId: seeded.org.id,
        projectId: seeded.project.id,
      }),
      headers: '{}',
      createdAt: Date.now(),
      availableAt: Date.now(),
    })
    .run();

  const [code] = await exited;
  assert.equal(code, 0, output());
  assert.match(output(), /worker stopped cleanly/);
  const late = db.select().from(outboxMessages).where(eq(outboxMessages.id, lateId)).get();
  assert.ok(late, 'the message added after the signal was not published');
  assert.equal(late.leaseOwner, null, 'nor claimed');
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  assert.equal(job?.status, 'completed', 'the long job was let finish');
});
