import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { loadEnv } from '../../src/config/env';

// The env parsers (readPort / readIntFromEnv / readNonNegativeIntFromEnv) are
// the app's config-correctness logic: each has a fallback, a NaN reject, a
// range/sign reject, and a happy path. loadEnv reads process.env, so each case
// sets one variable and restores it afterward. (Scoped, on-demand mutation
// audit territory per the guidelines — these branches are worth pinning; the
// rest of src/ is deliberately pragmatic.)
const KEYS = [
  'OUTBOX_POLL_MS',
  'TASK_REMINDER_DELAY_MS',
  'PORT',
  'AUTH_SECRET',
  'NODE_ENV',
  'KAFKA_BROKERS',
];

describe('loadEnv parsing', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AUTH_SECRET = 'env-spec-secret-at-least-32-characters-xxxx';
    delete process.env.NODE_ENV; // resolves to 'development'
    delete process.env.KAFKA_BROKERS; // stay in-process
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('readIntFromEnv: fallback when unset, parses positive, rejects NaN and non-positive', () => {
    delete process.env.OUTBOX_POLL_MS;
    assert.equal(loadEnv().outbox.pollIntervalMs, 2_000);

    process.env.OUTBOX_POLL_MS = '500';
    assert.equal(loadEnv().outbox.pollIntervalMs, 500);

    process.env.OUTBOX_POLL_MS = 'not-a-number';
    assert.throws(() => loadEnv(), /Invalid OUTBOX_POLL_MS/);

    // Zero and negatives are invalid for a poll interval (readIntFromEnv rejects
    // `<= 0`) — distinct from the reminder delay below, where zero is valid.
    process.env.OUTBOX_POLL_MS = '0';
    assert.throws(() => loadEnv(), /Invalid OUTBOX_POLL_MS/);
    process.env.OUTBOX_POLL_MS = '-5';
    assert.throws(() => loadEnv(), /Invalid OUTBOX_POLL_MS/);
  });

  test('readNonNegativeIntFromEnv: zero is valid (due immediately), negatives and NaN are not', () => {
    delete process.env.TASK_REMINDER_DELAY_MS;
    assert.equal(loadEnv().taskReminderDelayMs, 60_000);

    process.env.TASK_REMINDER_DELAY_MS = '0';
    assert.equal(loadEnv().taskReminderDelayMs, 0);

    process.env.TASK_REMINDER_DELAY_MS = '250';
    assert.equal(loadEnv().taskReminderDelayMs, 250);

    process.env.TASK_REMINDER_DELAY_MS = '-1';
    assert.throws(() => loadEnv(), /Invalid TASK_REMINDER_DELAY_MS/);
    process.env.TASK_REMINDER_DELAY_MS = 'abc';
    assert.throws(() => loadEnv(), /Invalid TASK_REMINDER_DELAY_MS/);
  });

  test('readPort: defaults to 3000, parses a valid port, rejects NaN and out-of-range', () => {
    delete process.env.PORT;
    assert.equal(loadEnv().port, 3000);

    process.env.PORT = '8080';
    assert.equal(loadEnv().port, 8080);

    process.env.PORT = 'abc';
    assert.throws(() => loadEnv(), /Invalid PORT/);
    process.env.PORT = '70000'; // > 65535
    assert.throws(() => loadEnv(), /Invalid PORT/);
    process.env.PORT = '-1';
    assert.throws(() => loadEnv(), /Invalid PORT/);
  });
});
