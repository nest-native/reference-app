import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { KafkaProducerService } from '@nest-native/kafka';
import { createMockKafkaProducer } from '@nest-native/kafka/testing';
import type { OutboxMessage } from '@nestjs/outbox';
import { KafkaOutboxTransport } from '../../src/modules/outbox/kafka-outbox.transport';

// Unit test: no live broker. The mock producer records every send() call, so we
// assert exactly what the transport publishes — topic prefixing, the key
// derivation, the wire headers, and a JSON round-trip of the value.
function makeTransport(prefix: string) {
  const mock = createMockKafkaProducer();
  const service = new KafkaProducerService(mock.producer);
  const transport = new KafkaOutboxTransport(service, prefix);
  return { transport, calls: mock.calls };
}

/** A message as the relay hands it over, the business key in its headers. */
function message(
  id: string,
  payload: unknown,
  idempotencyKey?: string,
): OutboxMessage {
  return {
    id,
    topic: 'user.invited',
    payload,
    headers: idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {},
    key: null,
    createdAt: Date.now(),
    availableAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
}

const live = () => ({ signal: new AbortController().signal });

test('prefixes the topic and uses the idempotency key as the message key', async () => {
  const { transport, calls } = makeTransport('refapp.');

  await transport.publish(
    message('evt-1', { invitedEmail: 'a@b.test', orgId: 7 }, 'user.invited:7:42:9'),
    live(),
  );

  assert.equal(calls.send.length, 1);
  const record = calls.send[0];
  assert.equal(record?.topic, 'refapp.user.invited', 'topic is prefixed');

  const sent = record?.messages[0];
  assert.equal(
    sent?.key,
    'user.invited:7:42:9',
    'key is the idempotency key when present',
  );
});

test('falls back to the message id as the key when there is no idempotency key', async () => {
  const { transport, calls } = makeTransport('');

  await transport.publish(message('evt-no-idem', { hello: 'world' }), live());

  const sent = calls.send[0]?.messages[0];
  assert.equal(sent?.key, 'evt-no-idem', 'key falls back to the message id');
  assert.equal(sent?.headers?.['x-idempotency-key'], 'evt-no-idem');
  assert.equal(calls.send[0]?.topic, 'user.invited', 'no prefix → bare topic');
});

test('sets the wire headers and JSON-encodes the payload', async () => {
  const { transport, calls } = makeTransport('p-');
  const payload = { invitedEmail: 'c@d.test', orgId: 3, projectId: 5 };

  await transport.publish(message('evt-headers', payload, 'idem-xyz'), live());

  const sent = calls.send[0]?.messages[0];
  assert.deepEqual(sent?.headers, {
    'x-event-id': 'evt-headers',
    'x-idempotency-key': 'idem-xyz',
  });

  // value is a JSON string the consumer parses back to the original payload.
  assert.equal(typeof sent?.value, 'string');
  assert.deepEqual(JSON.parse(sent?.value as string), payload);
});

test('an attempt the relay already gave up on sends nothing', async () => {
  const { transport, calls } = makeTransport('');
  const controller = new AbortController();
  controller.abort(new Error('publish timed out'));

  await assert.rejects(
    () => transport.publish(message('evt-late', {}), { signal: controller.signal }),
    /publish timed out/,
  );
  assert.equal(calls.send.length, 0);
});
