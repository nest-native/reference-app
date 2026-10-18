import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// The inbox table of @nest-native/messaging, which the app ran on before the
// official @nestjs/outbox. The definition is the library's, verbatim, so
// drizzle-kit sees no change; it stays only until its dedup records have been
// carried over to `outbox_inbox` and the table is dropped.
export const inboxEvents = sqliteTable(
  'inbox_events',
  {
    id: text('id').primaryKey(),
    messageKey: text('message_key').notNull(),
    source: text('source').notNull(),
    status: text('status').$type<'processed' | 'dead_lettered'>().notNull(),
    processedAt: text('processed_at').notNull(),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('inbox_events_source_message_key_unique').on(
      table.source,
      table.messageKey,
    ),
  ],
);

export type InboxEvent = typeof inboxEvents.$inferSelect;
export type NewInboxEvent = typeof inboxEvents.$inferInsert;
