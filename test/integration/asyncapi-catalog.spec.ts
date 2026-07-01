import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DiagnosticSeverity, Parser } from '@asyncapi/parser';
import {
  type AsyncApiDocument,
  getAsyncApiDocument,
} from '@nest-native/asyncapi';
import { seedDatabase } from '../../scripts/seed';

// Each of the four domain events is documented as its own channel whose address
// is the exact Kafka topic the outbox publishes to.
const EXPECTED_CHANNELS = [
  'user.invited',
  'task.created',
  'task.assigned',
  'task.completed',
];
const EXPECTED_OPERATIONS = [
  'publishUserInvited',
  'publishTaskCreated',
  'publishTaskAssigned',
  'publishTaskCompleted',
];
const EXPECTED_MESSAGES = [
  'UserInvited',
  'TaskCreated',
  'TaskAssigned',
  'TaskCompleted',
];

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-asyncapi-catalog-${process.pid}-${Date.now()}.db`,
);

let app: INestApplicationContext;
let doc: AsyncApiDocument;

before(async () => {
  process.env.DATABASE_URL = dbPath;
  process.env.AUTH_SECRET = 'asyncapi-catalog-secret-at-least-32-chars-xxxxx';
  // seedDatabase runs the drizzle migrations, so the app context boots against a
  // valid schema — the same bootstrap the other integration specs use.
  seedDatabase(dbPath);

  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  doc = getAsyncApiDocument(app, {
    title: 'Reference App Events',
    version: '1.0.0',
    description: 'Domain-event catalog generated at test time.',
  });
});

after(async () => {
  await app.close();
});

test('generates an AsyncAPI 3.0.0 document', () => {
  assert.equal(doc.asyncapi, '3.0.0');
  assert.equal(doc.info.title, 'Reference App Events');
  assert.equal(doc.info.version, '1.0.0');

  // The Kafka broker is declared as a server the channels are available on.
  assert.ok(doc.servers, 'document has no servers');
  assert.ok(doc.servers.kafka, 'no kafka server declared');
  assert.equal(doc.servers.kafka.protocol, 'kafka');
});

test('documents a channel, send operation and message for all four events', () => {
  for (const channelId of EXPECTED_CHANNELS) {
    const channel = doc.channels[channelId];
    assert.ok(channel, `missing channel "${channelId}"`);
    // Address must equal the Kafka topic external consumers subscribe to.
    assert.equal(channel.address, channelId);
    assert.ok(channel.messages, `channel "${channelId}" carries no messages`);
  }

  for (const operationId of EXPECTED_OPERATIONS) {
    const operation = doc.operations[operationId];
    assert.ok(operation, `missing operation "${operationId}"`);
    // The app produces these events, so every operation is a `send`.
    assert.equal(operation.action, 'send');
    assert.equal(operation.messages?.length, 1);
  }

  const messages = doc.components.messages ?? {};
  for (const messageName of EXPECTED_MESSAGES) {
    const message = messages[messageName];
    assert.ok(message, `missing message "${messageName}"`);
    assert.equal(message.contentType, 'application/json');
    assert.ok(message.payload, `message "${messageName}" has no payload`);
    // Every event carries the x-event-id / x-idempotency-key wire headers.
    assert.ok(message.headers, `message "${messageName}" has no headers`);
  }

  // The shared header schema is registered once under `EventHeaders`.
  const schemas = doc.components.schemas ?? {};
  assert.ok(schemas.EventHeaders, 'EventHeaders schema not registered');
});

test('validates cleanly against @asyncapi/parser (0 error diagnostics)', async () => {
  const parser = new Parser();
  // Validate the serialized JSON — exactly what is served at /asyncapi-json.
  const { diagnostics } = await parser.parse(JSON.stringify(doc));
  const errors = diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  assert.equal(
    errors.length,
    0,
    `expected 0 error diagnostics, got: ${JSON.stringify(errors, null, 2)}`,
  );
});
