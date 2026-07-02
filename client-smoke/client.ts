import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { OutboxClaimer } from '@nest-native/messaging';
import type { AppRouter } from '../src/@generated/server';
import { seedDatabase } from '../scripts/seed';

const trpcPath = '/trpc';
const SECRET =
  'client-smoke-secret-must-be-at-least-32-characters-xxxxxx';

async function main(): Promise<void> {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-client-smoke-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = SECRET;
  const seeded = seedDatabase(dbPath);

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  // Two clients: one unauthenticated (for ping + login), one authenticated
  // (after we have a token). The headers callback on httpBatchLink lets us
  // build the second client once we have the token.
  //
  // The server runs `transformer: superjson`, so the generated AppRouter is
  // marked transformer-enabled: dropping `transformer: superjson` from either
  // link below is a compile-time error (`npm run client-smoke:typecheck`).
  const anonClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({ url: `${baseUrl}${trpcPath}`, transformer: superjson }),
    ],
  });

  try {
    // 1. Query (no auth required)
    const ping = await anonClient.ping.query();
    assert.equal(ping, 'pong');
    console.warn(`ping → ${ping}`);

    // 2. Mutation (auth.login)
    const login = await anonClient.auth.login.mutate({
      email: 'admin@acme.test',
      password: 'admin123!',
    });
    assert.equal(login.user.email, 'admin@acme.test');
    assert.ok(login.organization);
    console.warn(
      `auth.login → user=${login.user.email} org=#${login.organization.id} token=…${login.token.slice(-8)}`,
    );

    // 3. Auth-protected query (users.me) — uses the token from step 2
    const authClient = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}${trpcPath}`,
          headers: () => ({ authorization: `Bearer ${login.token}` }),
          transformer: superjson,
        }),
      ],
    });
    const me = await authClient.users.me.query();
    assert.equal(me.email, 'admin@acme.test');
    console.warn(`users.me → #${me.id} ${me.email}`);

    // 4. superjson Date round-trip — create a task, let the outbox claimer
    //    project it into the activity feed, then read the feed. `createdAt`
    //    arrives as a real `Date` instance (and is *typed* as one), because
    //    the link transformer above matches the server's `transformer`.
    const task = await authClient.tasks.create.mutate({
      projectId: seeded.project.id,
      title: 'Prove the Date round-trip',
    });
    assert.equal(task.projectId, seeded.project.id);
    await app.get(OutboxClaimer).tick();

    const feed = await authClient.activity.list.query({
      projectId: seeded.project.id,
    });
    const entry = feed[0];
    assert.ok(entry, 'expected a task.created activity row after the tick');
    const createdAt: Date = entry.createdAt; // inferred `Date`, not `string`
    assert.ok(createdAt instanceof Date, 'createdAt must be a real Date');
    assert.ok(Math.abs(Date.now() - createdAt.getTime()) < 60_000);
    console.warn(
      `activity.list → "${entry.summary}" createdAt instanceof Date (${createdAt.toISOString()})`,
    );

    console.warn('client-smoke: ok');
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
