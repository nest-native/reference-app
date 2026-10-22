import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import superjson from 'superjson';
import { seedDatabase } from '../../scripts/seed';

// Express's body parser inflates `Content-Encoding` bodies through Node's zlib
// before any guard runs, on every path. `createApp` turns that off: a
// compressed body is answered 415 and never reaches the decoder. The plain
// request in the same test is the control that the parser still works.

const trpcPath = '/trpc';
const AUTH_SECRET = 'e2e-test-secret-must-be-at-least-32-characters-xxx';

let app: INestApplication;
let baseUrl: string;

before(async () => {
  const dbPath = join(
    tmpdir(),
    `nest-native-reference-app-e2e-compressed-${process.pid}-${Date.now()}.db`,
  );
  process.env.DATABASE_URL = dbPath;
  process.env.TRPC_PATH = trpcPath;
  process.env.AUTH_SECRET = AUTH_SECRET;

  seedDatabase(dbPath);

  const { createApp } = await import('../../src/create-app');
  app = await createApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app.close();
});

const loginBody = Buffer.from(
  JSON.stringify(superjson.serialize({ email: 'admin@acme.test', password: 'admin123!' })),
);

async function login(body: Buffer, encoding?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (encoding) {
    headers['content-encoding'] = encoding;
  }
  return fetch(`${baseUrl}${trpcPath}/auth.login`, {
    method: 'POST',
    headers,
    // a fresh Uint8Array: Buffer's ArrayBufferLike backing is not a BodyInit
    body: new Uint8Array(body),
  });
}

test('a plain JSON body still logs in', async () => {
  const response = await login(loginBody);
  assert.equal(response.status, 200);
});

test('a gzip-compressed body is refused with 415 before authentication', async () => {
  const response = await login(gzipSync(loginBody), 'gzip');
  assert.equal(response.status, 415);
});

test('a brotli-compressed body is refused with 415 before authentication', async () => {
  const response = await login(brotliCompressSync(loginBody), 'br');
  assert.equal(response.status, 415);
});
