import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PermanentError, RetryableError } from '@nest-native/messaging';
import {
  actionForError,
  actionForOutcome,
  deriveDedupKey,
} from '@nest-native/messaging/kafka';

// Pure unit tests for the consumer-side decision logic — no broker, no Nest.

test('deriveDedupKey prefers x-event-id over everything', () => {
  const key = deriveDedupKey(
    { 'x-event-id': 'evt-1', 'x-idempotency-key': 'idem-1' },
    'kafka-key',
  );
  assert.equal(key, 'evt-1');
});

test('deriveDedupKey falls back to x-idempotency-key, then the kafka key', () => {
  assert.equal(
    deriveDedupKey({ 'x-idempotency-key': 'idem-2' }, 'kafka-key'),
    'idem-2',
  );
  assert.equal(deriveDedupKey({}, 'kafka-key'), 'kafka-key');
  assert.equal(deriveDedupKey(undefined, 'kafka-key'), 'kafka-key');
});

test('deriveDedupKey decodes Buffer header values', () => {
  const key = deriveDedupKey(
    { 'x-event-id': Buffer.from('evt-buf', 'utf8') },
    undefined,
  );
  assert.equal(key, 'evt-buf');
});

test('deriveDedupKey throws PermanentError when nothing is keyable', () => {
  assert.throws(() => deriveDedupKey({}, undefined), PermanentError);
  assert.throws(() => deriveDedupKey(undefined, ''), PermanentError);
});

test('actionForOutcome acks both processed and duplicate', () => {
  assert.equal(actionForOutcome('processed'), 'ack');
  assert.equal(actionForOutcome('duplicate'), 'ack');
});

test('actionForError dead-letters PermanentError and redelivers the rest', () => {
  assert.equal(actionForError(new PermanentError('bad')), 'dead-letter');
  assert.equal(actionForError(new RetryableError('later')), 'redeliver');
  assert.equal(actionForError(new Error('boom')), 'redeliver');
});
