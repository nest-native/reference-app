import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';
import { OutboxClaimer } from '@nest-native/messaging';
import { seedDatabase } from '../../scripts/seed';

// Exercises the streaming AI project assistant end-to-end over HTTP with the
// offline mock model — no API key, no network. It seeds REAL activity by
// driving a full task lifecycle through the tRPC mutations and draining the
// outbox into the activity feed, then asserts the SSE stream replays that feed.

const trpcPath = '/trpc';
const TASK_TITLE = 'Draft the Q3 roadmap';

let app: INestApplication;
let baseUrl: string;
let token: string;
let projectId: number;
let adminId: number;

// The server runs `transformer: superjson`, so raw tRPC payloads are
// superjson envelopes in both directions.
interface TrpcSuccess {
  result: { data: SuperJSONResult };
}

const authHeaders = (): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

async function trpcMutation<T>(proc: string, input: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}${trpcPath}/${proc}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(superjson.serialize(input)),
  });
  assert.equal(r.status, 200, `POST ${proc} expected 200`);
  const body = (await r.json()) as TrpcSuccess;
  return superjson.deserialize<T>(body.result.data);
}

// Reconstruct the streamed text from the AI SDK UI-message SSE frames: keep the
// `text-delta` frames and concatenate their `delta` fields.
function concatTextDeltas(sse: string): string {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line.length > 0 && line !== '[DONE]')
    .map((line) => JSON.parse(line) as { type: string; delta?: string })
    .filter((frame) => frame.type === 'text-delta')
    .map((frame) => frame.delta ?? '')
    .join('');
}

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-assistant-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET =
    'assistant-secret-must-be-at-least-32-characters-xx';
  // Force the offline mock model: the assistant must stream without a provider.
  delete process.env.OPENAI_API_KEY;

  const seeded = seedDatabase(dbPath);
  projectId = seeded.project.id;
  adminId = seeded.admin.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = (await fetch(`${baseUrl}${trpcPath}/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      superjson.serialize({ email: 'admin@acme.test', password: 'admin123!' }),
    ),
  }).then((r) => r.json())) as TrpcSuccess;
  token = superjson.deserialize<{ token: string }>(login.result.data).token;

  // A full task lifecycle enqueues 3 outbox events (created/assigned/completed).
  const created = await trpcMutation<{ id: number }>('tasks.create', {
    projectId,
    title: TASK_TITLE,
  });
  await trpcMutation('tasks.assign', { id: created.id, assigneeId: adminId });
  await trpcMutation('tasks.complete', { id: created.id });

  // Drain the outbox into the activity-feed read-model the assistant reads.
  await app.get(OutboxClaimer).tick();
});

after(async () => {
  await app.close();
});

test('streams an SSE status update built from the seeded activity feed', async () => {
  const res = await fetch(`${baseUrl}/projects/${projectId}/assistant`, {
    method: 'POST',
    headers: authHeaders(),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  // The defaultHeaders configured on AiModule.forRoot reach the stream.
  assert.match(res.headers.get('x-powered-by') ?? '', /nest-native-ai/);

  const body = await res.text();
  // The response is the AI SDK UI-message protocol: it carries text-delta frames.
  assert.ok(
    body.includes('"type":"text-delta"'),
    'expected text-delta frames in the SSE stream',
  );

  // The concatenated deltas are the digest the mock replayed — real feed data.
  const streamed = concatTextDeltas(body);
  assert.ok(
    streamed.includes(TASK_TITLE),
    `streamed summary should mention the seeded task "${TASK_TITLE}"`,
  );
  assert.ok(
    streamed.toLowerCase().includes('completed'),
    'streamed summary should mention the completed task',
  );
});

test('rejects an unauthenticated caller with 401 before opening the stream', async () => {
  const res = await fetch(`${baseUrl}/projects/${projectId}/assistant`, {
    method: 'POST',
  });
  // The guard runs before the interceptor, so this is a plain HTTP error…
  assert.equal(res.status, 401);
  // …not an SSE stream.
  assert.doesNotMatch(
    res.headers.get('content-type') ?? '',
    /text\/event-stream/,
  );
  await res.body?.cancel();
});
