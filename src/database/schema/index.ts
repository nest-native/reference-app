import { activityEvents } from './activity';
import { auditEvents } from './audit-events';
import { inboxEvents } from './inbox-events';
import { jobs } from './jobs';
import { memberships } from './memberships';
import { organizations } from './organizations';
import { outboxEvents } from './outbox-events';
import { projects } from './projects';
import { tasks } from './tasks';
import { users } from './users';

export const schema = {
  organizations,
  users,
  memberships,
  projects,
  tasks,
  activityEvents,
  auditEvents,
  outboxEvents,
  inboxEvents,
  jobs,
};

export {
  activityEvents,
  auditEvents,
  inboxEvents,
  jobs,
  memberships,
  organizations,
  outboxEvents,
  projects,
  tasks,
  users,
};
export type { ActivityEvent, NewActivityEvent } from './activity';
export type { InboxEvent, InboxStatus, NewInboxEvent } from './inbox-events';
export { INBOX_STATUSES } from './inbox-events';
export type { AuditEvent, NewAuditEvent } from './audit-events';
export type { Job, JobStatus, NewJob } from './jobs';
export { JOB_STATUSES } from './jobs';
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
export type { NewTask, Task, TaskStatus } from './tasks';
export { TASK_STATUSES } from './tasks';
export type { NewUser, User } from './users';
