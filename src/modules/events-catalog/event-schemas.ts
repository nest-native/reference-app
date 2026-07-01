import type {
  AsyncApiSchemaObject,
  AsyncApiServerOptions,
  JsonSchemaSource,
} from '@nest-native/asyncapi';

/**
 * JSON-schema source of truth for the domain-event catalog.
 *
 * This app is Zod/interface-based, not `class-validator`-based, so the catalog
 * documents its payloads with hand-written JSON Schema ({@link JsonSchemaSource})
 * rather than `@nestjs/swagger` DTO classes — no extra runtime dependency is
 * pulled in. Each schema mirrors the matching payload interface in
 * `src/modules/outbox/outbox.constants.ts`; keep the two in sync when a payload
 * changes. The shapes are draft-07-compatible JSON Schema, which is the dialect
 * AsyncAPI 3.0 uses for message `payload` and `headers`.
 */

/** An integer field (the tenant/entity ids are all integer primary keys). */
function intField(description: string): AsyncApiSchemaObject {
  return { type: 'integer', description };
}

/** A string field, optionally carrying a JSON Schema `format`. */
function stringField(
  description: string,
  format?: string,
): AsyncApiSchemaObject {
  return format
    ? { type: 'string', format, description }
    : { type: 'string', description };
}

/** Mirrors `UserInvitedPayload`. */
export const userInvitedSchema: AsyncApiSchemaObject = {
  type: 'object',
  title: 'UserInvitedPayload',
  description: 'Emitted when a user is invited to an organization project.',
  properties: {
    invitedEmail: stringField('Email address the invitation was sent to', 'email'),
    invitedUserId: intField('Id of the newly-invited user'),
    invitedByUserId: intField('Id of the user who sent the invitation'),
    orgId: intField('Tenant (organization) the invitation belongs to'),
    projectId: intField('Project the user was invited to'),
  },
  required: [
    'invitedEmail',
    'invitedUserId',
    'invitedByUserId',
    'orgId',
    'projectId',
  ],
};

/** Mirrors `TaskCreatedPayload`. */
export const taskCreatedSchema: AsyncApiSchemaObject = {
  type: 'object',
  title: 'TaskCreatedPayload',
  description: 'Emitted when a task is created in a project.',
  properties: {
    taskId: intField('Id of the created task'),
    orgId: intField('Tenant (organization) the task belongs to'),
    projectId: intField('Project the task belongs to'),
    title: stringField('Human-readable task title'),
    createdBy: intField('Id of the user who created the task'),
  },
  required: ['taskId', 'orgId', 'projectId', 'title', 'createdBy'],
};

/** Mirrors `TaskAssignedPayload`. */
export const taskAssignedSchema: AsyncApiSchemaObject = {
  type: 'object',
  title: 'TaskAssignedPayload',
  description: 'Emitted when a task is assigned to a user.',
  properties: {
    taskId: intField('Id of the assigned task'),
    orgId: intField('Tenant (organization) the task belongs to'),
    projectId: intField('Project the task belongs to'),
    assigneeId: intField('Id of the user the task was assigned to'),
    assignedBy: intField('Id of the user who assigned the task'),
  },
  required: ['taskId', 'orgId', 'projectId', 'assigneeId', 'assignedBy'],
};

/** Mirrors `TaskCompletedPayload`. */
export const taskCompletedSchema: AsyncApiSchemaObject = {
  type: 'object',
  title: 'TaskCompletedPayload',
  description: 'Emitted when a task is marked complete.',
  properties: {
    taskId: intField('Id of the completed task'),
    orgId: intField('Tenant (organization) the task belongs to'),
    projectId: intField('Project the task belongs to'),
    completedBy: intField('Id of the user who completed the task'),
  },
  required: ['taskId', 'orgId', 'projectId', 'completedBy'],
};

/**
 * The wire headers every event carries, set by the Kafka outbox transport in
 * `@nest-native/messaging`. Both are always present, so both are required.
 */
export const eventHeadersSchema: AsyncApiSchemaObject = {
  type: 'object',
  title: 'EventHeaders',
  description:
    'Wire headers set on every published event by the transactional-outbox ' +
    'Kafka transport. The Kafka message key is `x-idempotency-key` (falling ' +
    'back to `x-event-id`), giving per-entity ordering and the value the ' +
    "consumer's inbox deduplicates on.",
  properties: {
    'x-event-id': stringField(
      'Unique producer-assigned id of this event (most stable dedup input)',
    ),
    'x-idempotency-key': stringField(
      'Business idempotency key, e.g. `task.created:<orgId>:<taskId>`',
    ),
  },
  required: ['x-event-id', 'x-idempotency-key'],
};

/** Message payload sources (name → JSON Schema) referenced by the handlers. */
export const userInvitedMessageSource: JsonSchemaSource = {
  name: 'UserInvited',
  schema: userInvitedSchema,
};
export const taskCreatedMessageSource: JsonSchemaSource = {
  name: 'TaskCreated',
  schema: taskCreatedSchema,
};
export const taskAssignedMessageSource: JsonSchemaSource = {
  name: 'TaskAssigned',
  schema: taskAssignedSchema,
};
export const taskCompletedMessageSource: JsonSchemaSource = {
  name: 'TaskCompleted',
  schema: taskCompletedSchema,
};

/**
 * Shared headers source. Registered once in `components.schemas` (the generator
 * deduplicates structurally-identical schemas by name), so every message
 * references the same `EventHeaders` definition.
 */
export const eventHeadersSource: JsonSchemaSource = {
  name: 'EventHeaders',
  schema: eventHeadersSchema,
};

/** The Kafka server (broker) name used as the `servers` map key. */
export const KAFKA_SERVER_NAME = 'kafka';

/**
 * The documented broker host. This is the local Redpanda dev listener from
 * `docker-compose.yml` (`KAFKA_BROKERS=localhost:19092` for the gated e2e);
 * real broker hosts are environment-specific and injected via `KAFKA_BROKERS`.
 */
export const KAFKA_SERVER_HOST = 'localhost:19092';

/** Server metadata shared by every channel handler's `@AsyncApiServer`. */
export const kafkaServerOptions: AsyncApiServerOptions = {
  title: 'Reference App Kafka broker',
  description:
    'Kafka-API-compatible broker the app publishes its outbox to when the ' +
    'Kafka profile is enabled (KAFKA_BROKERS set). Topics are the channel ' +
    'addresses below, optionally prefixed by KAFKA_TOPIC_PREFIX.',
};

/**
 * Document-level `info` for the catalog, shared by `main.ts` (served document)
 * and the integration test so both describe the same catalog.
 */
export const EVENTS_CATALOG_INFO = {
  title: 'Reference App Events',
  version: '1.0.0',
  description:
    'AsyncAPI 3.0 catalog of the domain events the nest-native reference app ' +
    'publishes to Kafka through its transactional outbox. External teams ' +
    'integrate against these channels — each channel address is the Kafka ' +
    'topic the event is published to.',
} as const;
