import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  trpcPath: string;
  authSecret: string;
  authTtlSeconds: number;
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    stuckTimeoutMs: number;
    workerInstanceId: string | undefined;
  };
}

const MIN_AUTH_SECRET_LENGTH = 32;
const DEV_AUTH_SECRET =
  'dev-only-secret-not-for-production-' + 'x'.repeat(MIN_AUTH_SECRET_LENGTH);

function readAuthSecret(nodeEnv: AppEnv['nodeEnv']): string {
  const raw = process.env.AUTH_SECRET;
  if (raw && raw.length >= MIN_AUTH_SECRET_LENGTH) return raw;
  if (raw) {
    throw new Error(
      `AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters`,
    );
  }
  if (nodeEnv === 'production') {
    throw new Error('AUTH_SECRET is required when NODE_ENV=production');
  }
  return DEV_AUTH_SECRET;
}

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 3000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return parsed;
}

function readDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return join(
    tmpdir(),
    `nest-native-reference-app-${process.pid}-${Date.now()}.db`,
  );
}

function readIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  return {
    nodeEnv,
    port: readPort(),
    databaseUrl: readDatabaseUrl(),
    trpcPath: process.env.TRPC_PATH ?? '/trpc',
    authSecret: readAuthSecret(nodeEnv),
    authTtlSeconds: Number.parseInt(process.env.AUTH_TTL_SECONDS ?? '3600', 10),
    outbox: {
      pollIntervalMs: readIntFromEnv('OUTBOX_POLL_MS', 2_000),
      batchSize: readIntFromEnv('OUTBOX_BATCH_SIZE', 32),
      stuckTimeoutMs: readIntFromEnv('OUTBOX_STUCK_TIMEOUT_MS', 60_000),
      workerInstanceId: process.env.OUTBOX_WORKER_ID,
    },
  };
}
