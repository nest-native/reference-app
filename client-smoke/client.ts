import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
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
  seedDatabase(dbPath);

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  // Two clients: one unauthenticated (for ping + login), one authenticated
  // (after we have a token). The headers callback on httpBatchLink lets us
  // build the second client once we have the token.
  const anonClient = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${baseUrl}${trpcPath}` })],
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
        }),
      ],
    });
    const me = await authClient.users.me.query();
    assert.equal(me.email, 'admin@acme.test');
    console.warn(`users.me → #${me.id} ${me.email}`);

    console.warn('client-smoke: ok');
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
