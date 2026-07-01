import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { organizations } from './organizations';
import { users } from './users';

/**
 * The activity feed read-model — an append-only projection fed by the tasks
 * lifecycle events (`task.created` / `task.assigned` / `task.completed`). It is
 * written by the in-process handler and the Kafka inbox consumer, never by the
 * tasks service directly, so the feed stays a pure downstream of the outbox.
 *
 * `dedupKey` + the `(org_id, dedup_key)` unique index are the read-model's OWN
 * idempotency guard: the same logical event delivered twice (a worker re-tick or
 * a Kafka redelivery) resolves to the same key, so the second insert is a no-op
 * (`onConflictDoNothing`) and the feed never doubles up.
 */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: integer('project_id'),
    type: text('type').notNull(),
    actorUserId: integer('actor_user_id').references(() => users.id),
    summary: text('summary').notNull(),
    dedupKey: text('dedup_key').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('activity_events_org_dedup_key_unique').on(
      table.orgId,
      table.dedupKey,
    ),
  ],
);

export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
