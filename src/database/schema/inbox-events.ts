// The `inbox_events` table now ships from the messaging library (the consumer-side
// mirror of the outbox). The composite unique index on (source, message_key) is
// the dedup primitive — a redelivery violates it and the inbox treats the
// violation as "already processed". The generated migrations are unchanged.
import { inboxEvents } from '@nest-native/messaging/sqlite';

export { inboxEvents };
export { INBOX_STATUSES, type InboxStatus } from '@nest-native/messaging';

export type InboxEvent = typeof inboxEvents.$inferSelect;
export type NewInboxEvent = typeof inboxEvents.$inferInsert;
