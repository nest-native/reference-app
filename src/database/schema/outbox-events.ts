// The `outbox_events` table now ships from the messaging library so the app and
// the engine reason about byte-identical DDL (same columns, defaults, and the
// partial-unique + status/available indexes). The generated migrations are
// unchanged — they already match this table shape. Row types are derived from
// the imported table; the status union/const comes from the library core.
import { outboxEvents } from '@nest-native/messaging/sqlite';

export { outboxEvents };
export { OUTBOX_STATUSES, type OutboxStatus } from '@nest-native/messaging';

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
