import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface KafkaEnv {
  /** True when KAFKA_BROKERS is set — the opt-in profile switch. */
  enabled: boolean;
  /** Broker bootstrap addresses (comma-split from KAFKA_BROKERS). */
  brokers: string[];
  /** Client identifier reported to the broker. */
  clientId: string;
  /** Consumer group the inbox consumers join. */
  groupId: string;
  /** Prefix applied to every topic, so one cluster can host many environments. */
  topicPrefix: string;
}

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
  /** Delay before the assignment-reminder job runs (0 = due immediately). */
  taskReminderDelayMs: number;
  // Optional: present (and `enabled`) only when KAFKA_BROKERS is set. With it
  // unset the app stays in-process and this block is undefined — Kafka off is
  // byte-for-byte the default behaviour.
  kafka?: KafkaEnv;
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

// Unlike readIntFromEnv, zero is meaningful here: a 0ms reminder delay means
// "due immediately" (jobs' delayMs contract), which tests rely on.
function readNonNegativeIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

// KAFKA_BROKERS is the single opt-in switch: set it and the Kafka profile turns
// on (the app publishes the outbox to Kafka and runs the inbox consumers);
// leave it unset and this returns undefined so the app stays in-process.
function readKafka(): KafkaEnv | undefined {
  const brokersRaw = process.env.KAFKA_BROKERS;
  if (!brokersRaw) return undefined;
  const brokers = brokersRaw
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (brokers.length === 0) {
    throw new Error('KAFKA_BROKERS is set but contains no broker addresses');
  }
  return {
    enabled: true,
    brokers,
    clientId: process.env.KAFKA_CLIENT_ID ?? 'reference-app',
    groupId: process.env.KAFKA_GROUP_ID ?? 'reference-app',
    topicPrefix: process.env.KAFKA_TOPIC_PREFIX ?? '',
  };
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  const kafka = readKafka();
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
    taskReminderDelayMs: readNonNegativeIntFromEnv(
      'TASK_REMINDER_DELAY_MS',
      60_000,
    ),
    ...(kafka ? { kafka } : {}),
  };
}
