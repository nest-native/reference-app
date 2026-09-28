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

export interface RabbitmqEnv {
  /** True when RABBITMQ_URL is set — the opt-in profile switch. */
  enabled: boolean;
  /** The AMQP URL; its vhost is how one broker hosts many environments. */
  url: string;
  /** The topic exchange every outbox event is published to. */
  exchange: string;
}

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  trpcPath: string;
  authSecret: string;
  authTtlSeconds: number;
  /** Login lockout: failures allowed before an identity is locked. */
  lockoutLimit: number;
  /** Login lockout: how long a locked identity stays locked, in ms. */
  lockoutCooloffMs: number;
  /** Read cache: TTL for cached reads, in ms (the delivery backstop). */
  cacheTtlMs: number;
  /** Read cache: unix-socket path for cross-process invalidation (app + worker). Unset = in-process only. */
  cacheSocketPath: string | undefined;
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
  // Optional: present only when RABBITMQ_URL is set. The two broker profiles
  // are mutually exclusive — setting both fails at startup.
  rabbitmq?: RabbitmqEnv;
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

// RABBITMQ_URL is the RabbitMQ profile's single opt-in switch, as KAFKA_BROKERS
// is Kafka's: set it and the outbox relays to RabbitMQ and the inbox consumers
// subscribe; leave it unset and this returns undefined.
function readRabbitmq(): RabbitmqEnv | undefined {
  const url = process.env.RABBITMQ_URL?.trim();
  if (!url) return undefined;
  return {
    enabled: true,
    url,
    exchange: process.env.RABBITMQ_EXCHANGE ?? 'reference-app.events',
  };
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  const kafka = readKafka();
  const rabbitmq = readRabbitmq();
  if (kafka && rabbitmq) {
    // One outbox relays to one transport. Picking one silently would leave the
    // other broker's consumers waiting for events that never come.
    throw new Error(
      'KAFKA_BROKERS and RABBITMQ_URL are both set: choose one messaging profile',
    );
  }
  return {
    nodeEnv,
    port: readPort(),
    databaseUrl: readDatabaseUrl(),
    trpcPath: process.env.TRPC_PATH ?? '/trpc',
    authSecret: readAuthSecret(nodeEnv),
    // Fail fast: a NaN TTL would sign tokens with `exp: NaN` (never valid) and
    // a zero/negative one would mint tokens that are already expired.
    authTtlSeconds: readIntFromEnv('AUTH_TTL_SECONDS', 3600),
    lockoutLimit: readIntFromEnv('LOCKOUT_LIMIT', 5),
    lockoutCooloffMs: readIntFromEnv('LOCKOUT_COOLOFF_MS', 15 * 60_000),
    cacheTtlMs: readIntFromEnv('CACHE_TTL_MS', 30_000),
    cacheSocketPath: process.env.CACHE_SOCKET_PATH,
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
    ...(rabbitmq ? { rabbitmq } : {}),
  };
}
