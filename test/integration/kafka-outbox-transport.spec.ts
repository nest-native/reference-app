import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { KafkaProducerService } from '@nest-native/kafka';
import { createMockKafkaProducer } from '@nest-native/kafka/testing';
import { KafkaOutboxTransport } from '@nest-native/messaging/kafka';

// Unit test: no live broker. The mock producer records every send() call, so we
// assert exactly what the transport publishes — topic prefixing, the key
// derivation, the wire headers, and a JSON round-trip of the value.
function makeTransport(prefix: string) {
  const mock = createMockKafkaProducer();
  const service = new KafkaProducerService(mock.producer);
  const transport = new KafkaOutboxTransport(service, prefix);
  return { transport, calls: mock.calls };
}

test('prefixes the topic and uses idempotencyKey as the message key', async () => {
  const { transport, calls } = makeTransport('refapp.');

  await transport.publish({
    id: 'evt-1',
    topic: 'user.invited',
    payload: { invitedEmail: 'a@b.test', orgId: 7 },
    idempotencyKey: 'user.invited:7:42:9',
  });

  assert.equal(calls.send.length, 1);
  const record = calls.send[0];
  assert.equal(record?.topic, 'refapp.user.invited', 'topic is prefixed');

  const message = record?.messages[0];
  assert.equal(
    message?.key,
    'user.invited:7:42:9',
    'key is the idempotency key when present',
  );
});

test('falls back to the event id as the key when no idempotencyKey', async () => {
  const { transport, calls } = makeTransport('');

  await transport.publish({
    id: 'evt-no-idem',
    topic: 'user.invited',
    payload: { hello: 'world' },
  });

  const message = calls.send[0]?.messages[0];
  assert.equal(message?.key, 'evt-no-idem', 'key falls back to the event id');
  assert.equal(calls.send[0]?.topic, 'user.invited', 'no prefix → bare topic');
});

test('sets the wire headers and JSON-encodes the payload', async () => {
  const { transport, calls } = makeTransport('p-');
  const payload = { invitedEmail: 'c@d.test', orgId: 3, projectId: 5 };

  await transport.publish({
    id: 'evt-headers',
    topic: 'user.invited',
    payload,
    idempotencyKey: 'idem-xyz',
  });

  const message = calls.send[0]?.messages[0];
  assert.equal(message?.headers?.['x-event-id'], 'evt-headers');
  assert.equal(message?.headers?.['x-idempotency-key'], 'idem-xyz');

  // value is a JSON string the consumer parses back to the original payload.
  assert.equal(typeof message?.value, 'string');
  assert.deepEqual(JSON.parse(message?.value as string), payload);
});
