import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NonRetryableMessageError } from '@nestjs/outbox';
import { deriveDedupKey } from '../../src/modules/outbox/wire-contract';

// Pure unit tests for the consumer-side dedup key the broker consumers derive
// from the wire contract — no broker, no Nest.

test('deriveDedupKey prefers x-event-id over everything', () => {
  const key = deriveDedupKey(
    { 'x-event-id': 'evt-1', 'x-idempotency-key': 'idem-1' },
    'kafka-key',
  );
  assert.equal(key, 'evt-1');
});

test('deriveDedupKey falls back to x-idempotency-key, then the broker key', () => {
  assert.equal(
    deriveDedupKey({ 'x-idempotency-key': 'idem-2' }, 'kafka-key'),
    'idem-2',
  );
  assert.equal(deriveDedupKey({}, 'kafka-key'), 'kafka-key');
  assert.equal(deriveDedupKey(undefined, 'kafka-key'), 'kafka-key');
  assert.equal(
    deriveDedupKey({ 'x-event-id': '' }, 'kafka-key'),
    'kafka-key',
    'an empty header is no key',
  );
});

test('deriveDedupKey decodes Buffer header values', () => {
  const key = deriveDedupKey(
    { 'x-event-id': Buffer.from('evt-buf', 'utf8') },
    undefined,
  );
  assert.equal(key, 'evt-buf');
  assert.equal(
    deriveDedupKey({ 'x-event-id': [Buffer.from('evt-first'), 'evt-second'] }, undefined),
    'evt-first',
  );
});

test('deriveDedupKey refuses a message with nothing to key it: poison, not a retry', () => {
  assert.throws(() => deriveDedupKey({}, undefined), NonRetryableMessageError);
  assert.throws(() => deriveDedupKey(undefined, ''), NonRetryableMessageError);
});
