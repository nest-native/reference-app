import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { organizations } from './organizations';
import { users } from './users';

export const MEMBERSHIP_ROLES = ['admin', 'member', 'viewer'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const memberships = sqliteTable(
  'memberships',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<MembershipRole>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('memberships_org_user_unique').on(table.orgId, table.userId),
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
