import type { OutboxDeadLetterReason } from '@nestjs/outbox';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// The tables of the official outbox's store on this database
// (src/modules/outbox/sqlite-outbox.store.ts). @nestjs/outbox ships stores for
// PostgreSQL and MySQL only, so the app owns these, migrated by drizzle-kit
// like every other table. Times are epoch ms from the producers' and the
// relay's clocks; payload, headers and history are JSON text, a null payload
// SQL NULL.

/** The messages not yet published: a published one is deleted. */
export const outboxMessages = sqliteTable(
  'outbox_messages',
  {
    // A message's place in its key, assigned at insert under SQLite's single
    // write lock, so seq order is commit order. AUTOINCREMENT never hands a
    // number out twice: a requeued dead letter goes back to its own seq, ahead
    // of its key's later messages, even after the table was emptied.
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    topic: text('topic').notNull(),
    payload: text('payload'),
    headers: text('headers').notNull(),
    key: text('key'),
    createdAt: integer('created_at').notNull(),
    availableAt: integer('available_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    history: text('history').notNull().default('[]'),
    leaseOwner: text('lease_owner'),
    leaseUntil: integer('lease_until'),
  },
  (table) => [
    uniqueIndex('outbox_messages_id_unique').on(table.id),
    // What a claim probes for a keyed message: the older messages of its key.
    index('outbox_messages_key_seq_idx')
      .on(table.key, table.seq)
      .where(sql`${table.key} IS NOT NULL`),
  ],
);

/** Messages that ran out of attempts or were rejected; requeueing moves one back. */
export const outboxDeadLetters = sqliteTable(
  'outbox_dead_letters',
  {
    id: text('id').primaryKey(),
    seq: integer('seq').notNull(),
    topic: text('topic').notNull(),
    payload: text('payload'),
    headers: text('headers').notNull(),
    key: text('key'),
    createdAt: integer('created_at').notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
    history: text('history').notNull(),
    reason: text('reason').$type<OutboxDeadLetterReason>().notNull(),
    failedAt: integer('failed_at').notNull(),
  },
  (table) => [
    index('outbox_dead_letters_topic_failed_at_idx').on(
      table.topic,
      table.failedAt,
    ),
  ],
);

/**
 * Which consumer processed which message: the consumers' inbox. The primary key
 * makes recording one an insert-if-absent, so a redelivery finds it there.
 */
export const outboxInbox = sqliteTable(
  'outbox_inbox',
  {
    consumer: text('consumer').notNull(),
    messageId: text('message_id').notNull(),
    processedAt: integer('processed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.messageId] }),
    index('outbox_inbox_processed_at_idx').on(table.processedAt),
  ],
);

export type OutboxMessageRow = typeof outboxMessages.$inferSelect;
export type OutboxDeadLetterRow = typeof outboxDeadLetters.$inferSelect;
export type OutboxInboxRow = typeof outboxInbox.$inferSelect;
