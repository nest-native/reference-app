import type {
  AsyncApiServerOptions,
  ZodSchemaSource,
} from '@nest-native/asyncapi';
import { z } from 'zod';
import {
  taskAssignedPayloadSchema,
  taskCompletedPayloadSchema,
  taskCreatedPayloadSchema,
  userInvitedPayloadSchema,
} from '../outbox/outbox.constants';

/**
 * Schema sources for the domain-event catalog.
 *
 * The payload contracts are defined ONCE — as the Zod schemas in
 * `src/modules/outbox/outbox.constants.ts` that also drive the runtime guards —
 * and passed straight to `@AsyncApiMessage` as `{ name, schema }` sources.
 * `@nest-native/asyncapi` converts them natively with Zod 4's
 * `z.toJSONSchema()` (draft-7, the dialect AsyncAPI 3.0 uses), so the catalog
 * can never drift from what producers enqueue and consumers validate.
 */

/**
 * The wire headers every event carries, set by the Kafka outbox transport in
 * `@nest-native/messaging`. Both are always present, so both are required.
 * This is a transport concern (not an outbox payload contract), so the schema
 * lives here with the catalog rather than in `outbox.constants.ts`.
 */
export const eventHeadersSchema = z
  .object({
    'x-event-id': z
      .string()
      .describe(
        'Unique producer-assigned id of this event (most stable dedup input)',
      ),
    'x-idempotency-key': z
      .string()
      .describe('Business idempotency key, e.g. `task.created:<orgId>:<taskId>`'),
  })
  .meta({
    title: 'EventHeaders',
    description:
      'Wire headers set on every published event by the transactional-outbox ' +
      'Kafka transport. The Kafka message key is `x-idempotency-key` (falling ' +
      'back to `x-event-id`), giving per-entity ordering and the value the ' +
      "consumer's inbox deduplicates on.",
  });

/** Message payload sources (name → Zod schema) referenced by the handlers. */
export const userInvitedMessageSource: ZodSchemaSource = {
  name: 'UserInvited',
  schema: userInvitedPayloadSchema,
};
export const taskCreatedMessageSource: ZodSchemaSource = {
  name: 'TaskCreated',
  schema: taskCreatedPayloadSchema,
};
export const taskAssignedMessageSource: ZodSchemaSource = {
  name: 'TaskAssigned',
  schema: taskAssignedPayloadSchema,
};
export const taskCompletedMessageSource: ZodSchemaSource = {
  name: 'TaskCompleted',
  schema: taskCompletedPayloadSchema,
};

/**
 * Shared headers source. Registered once in `components.schemas` (the generator
 * deduplicates structurally-identical schemas by name), so every message
 * references the same `EventHeaders` definition.
 */
export const eventHeadersSource: ZodSchemaSource = {
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
