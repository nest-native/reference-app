import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organizations } from './organizations';
import { users } from './users';

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orgId: integer('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: text('created_at').notNull(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
