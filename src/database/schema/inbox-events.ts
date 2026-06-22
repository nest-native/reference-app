import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// The inbox is the consumer-side mirror of the outbox: it records which
// messages a consumer has already processed so a redelivery (Kafka's
// at-least-once contract) is deduplicated rather than re-applied. Unlike the
// outbox there is no `attempts` / poller bookkeeping — the broker owns retry,
// and a single row per (source, messageKey) is the entire dedup primitive.
export const INBOX_STATUSES = ['processed', 'dead_lettered'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const inboxEvents = sqliteTable(
  'inbox_events',
  {
    id: text('id').primaryKey(),
    messageKey: text('message_key').notNull(),
    source: text('source').notNull(),
    status: text('status').$type<InboxStatus>().notNull(),
    processedAt: text('processed_at').notNull(),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // Composite unique on (source, messageKey): both columns are NOT NULL so a
    // plain composite unique index is the right primitive (no partial WHERE).
    // The INSERT racing this index is the dedup mechanism — a duplicate
    // delivery violates it and the consumer treats the violation as "already
    // processed". `source` scopes keys per topic+group so two consumers can
    // share a key space without colliding.
    uniqueIndex('inbox_events_source_message_key_unique').on(
      table.source,
      table.messageKey,
    ),
  ],
);

export type InboxEvent = typeof inboxEvents.$inferSelect;
export type NewInboxEvent = typeof inboxEvents.$inferInsert;
