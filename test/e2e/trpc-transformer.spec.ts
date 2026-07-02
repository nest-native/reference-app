import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  createTRPCClient,
  httpBatchLink,
  TRPCClientError,
} from '@trpc/client';
import superjson from 'superjson';
import { OutboxClaimer } from '@nest-native/messaging';
import type { AppRouter } from '../../src/@generated/server';
import { seedDatabase } from '../../scripts/seed';

// End-to-end coverage for the tRPC 0.6 server-config options:
// - `transformer: superjson` → `Date` values round-trip to the typed client
// - `errorFormatter` → failing inputs expose the flattened ZodError
// (`responseMeta` is asserted at the raw HTTP level in trpc-ping.smoke.spec.ts.)

const trpcPath = '/trpc';

let app: INestApplication;
let client: ReturnType<typeof createTRPCClient<AppRouter>>;
let projectId: number;

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-transformer-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = 'e2e-transformer-secret-at-least-32-chars-xxxx';
  const seeded = seedDatabase(dbPath);
  projectId = seeded.project.id;

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  // The generated AppRouter is marked transformer-enabled, so the link
  // transformer below is *required* — removing it fails the typecheck.
  const anonClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({ url: `${baseUrl}${trpcPath}`, transformer: superjson }),
    ],
  });
  const login = await anonClient.auth.login.mutate({
    email: 'admin@acme.test',
    password: 'admin123!',
  });
  client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}${trpcPath}`,
        headers: () => ({ authorization: `Bearer ${login.token}` }),
        transformer: superjson,
      }),
    ],
  });
});

after(async () => {
  await app.close();
});

test('activity.list createdAt crosses the wire as a real Date', async () => {
  const task = await client.tasks.create.mutate({
    projectId,
    title: 'Ship the transformer showcase',
  });
  assert.equal(task.title, 'Ship the transformer showcase');

  // Drain the outbox so task.created is projected into the activity feed.
  await app.get(OutboxClaimer).tick();

  const feed = await client.activity.list.query({ projectId });
  const entry = feed.find((event) => event.type === 'task.created');
  assert.ok(entry, 'expected a task.created activity row after the tick');

  const createdAt: Date = entry.createdAt; // inferred `Date`, not `string`
  assert.ok(createdAt instanceof Date, 'createdAt must arrive as a Date');
  // A faithful round-trip preserves the instant, not just the type.
  assert.ok(Math.abs(Date.now() - createdAt.getTime()) < 60_000);
});

test('failing mutation input surfaces the flattened zodError to the client', async () => {
  let caught: unknown;
  try {
    await client.tasks.create.mutate({ projectId, title: '' });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TRPCClientError, 'expected a TRPCClientError');
  const data = caught.data as {
    code: string;
    httpStatus: number;
    zodError: { fieldErrors: Record<string, string[]> } | null;
  };
  assert.equal(data.code, 'BAD_REQUEST');
  assert.equal(data.httpStatus, 400);
  assert.ok(data.zodError, 'errorFormatter must attach the flattened ZodError');
  const titleErrors = data.zodError.fieldErrors.title;
  assert.ok(Array.isArray(titleErrors) && titleErrors.length > 0);
});

test('non-Zod errors keep the standard shape with zodError null', async () => {
  let caught: unknown;
  try {
    await client.projects.get.query({ id: 999_999 });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TRPCClientError, 'expected a TRPCClientError');
  const data = caught.data as {
    code: string;
    httpStatus: number;
    zodError: unknown;
  };
  assert.equal(data.code, 'NOT_FOUND');
  assert.equal(data.httpStatus, 404);
  assert.equal(data.zodError, null);
});
