import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// The outbox table of @nest-native/messaging, which the app ran on before the
// official @nestjs/outbox. The definition is the library's, verbatim, so
// drizzle-kit sees no change; it stays only until its unpublished events have
// been carried over to `outbox_messages` and the table is dropped.
export const outboxEvents = sqliteTable(
  'outbox_events',
  {
    id: text('id').primaryKey(),
    topic: text('topic').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text('status')
      .$type<'pending' | 'processing' | 'completed' | 'failed'>()
      .notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    idempotencyKey: text('idempotency_key'),
    availableAt: text('available_at').notNull(),
    claimedAt: text('claimed_at'),
    claimedBy: text('claimed_by'),
    processedAt: text('processed_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('outbox_events_idempotency_key_unique')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('outbox_events_status_available_idx').on(
      table.status,
      table.availableAt,
    ),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
