import { auditEvents } from './audit-events';
import { inboxEvents } from './inbox-events';
import { memberships } from './memberships';
import { organizations } from './organizations';
import { outboxEvents } from './outbox-events';
import { projects } from './projects';
import { users } from './users';

export const schema = {
  organizations,
  users,
  memberships,
  projects,
  auditEvents,
  outboxEvents,
  inboxEvents,
};

export {
  auditEvents,
  inboxEvents,
  memberships,
  organizations,
  outboxEvents,
  projects,
  users,
};
export type { InboxEvent, InboxStatus, NewInboxEvent } from './inbox-events';
export { INBOX_STATUSES } from './inbox-events';
export type { AuditEvent, NewAuditEvent } from './audit-events';
export type {
  Membership,
  MembershipRole,
  NewMembership,
} from './memberships';
export { MEMBERSHIP_ROLES } from './memberships';
export type { NewOrganization, Organization } from './organizations';
export type { NewOutboxEvent, OutboxEvent, OutboxStatus } from './outbox-events';
export { OUTBOX_STATUSES } from './outbox-events';
export type { NewProject, Project } from './projects';
export type { NewUser, User } from './users';
