import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organizations } from './organizations';
import { users } from './users';

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orgId: integer('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  actorUserId: integer('actor_user_id')
    .notNull()
    .references(() => users.id),
  action: text('action').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  metadata: text('metadata', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  createdAt: text('created_at').notNull(),
});

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
