import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organizations } from './organizations';
import { projects } from './projects';
import { users } from './users';

export const TASK_STATUSES = ['open', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orgId: integer('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  status: text('status').$type<TaskStatus>().notNull().default('open'),
  assigneeId: integer('assignee_id').references(() => users.id),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: text('created_at').notNull(),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
