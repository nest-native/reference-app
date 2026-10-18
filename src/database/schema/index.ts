import { activityEvents } from './activity';
import { auditEvents } from './audit-events';
import { inboxEvents } from './inbox-events';
import { jobs, jobSchedules } from './jobs';
import { lockoutAttempts } from './lockout-attempts';
import { memberships } from './memberships';
import { organizations } from './organizations';
import { outboxDeadLetters, outboxInbox, outboxMessages } from './outbox';
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
  outboxMessages,
  outboxDeadLetters,
  outboxInbox,
  jobs,
  jobSchedules,
  lockoutAttempts,
};

export {
  activityEvents,
  auditEvents,
  inboxEvents,
  jobs,
  jobSchedules,
  lockoutAttempts,
  memberships,
  organizations,
  outboxDeadLetters,
  outboxEvents,
  outboxInbox,
  outboxMessages,
  projects,
  tasks,
  users,
};
export type { ActivityEvent, NewActivityEvent } from './activity';
export type { InboxEvent, NewInboxEvent } from './inbox-events';
export type { AuditEvent, NewAuditEvent } from './audit-events';
export type {
  Job,
  JobSchedule,
  JobStatus,
  NewJob,
  NewJobSchedule,
} from './jobs';
export { JOB_STATUSES } from './jobs';
export type { LockoutAttempt, NewLockoutAttempt } from './lockout-attempts';
export type {
  Membership,
  MembershipRole,
  NewMembership,
} from './memberships';
export { MEMBERSHIP_ROLES } from './memberships';
export type { NewOrganization, Organization } from './organizations';
export type {
  OutboxDeadLetterRow,
  OutboxInboxRow,
  OutboxMessageRow,
} from './outbox';
export type { NewOutboxEvent, OutboxEvent } from './outbox-events';
export type { NewProject, Project } from './projects';
export type { NewTask, Task, TaskStatus } from './tasks';
export { TASK_STATUSES } from './tasks';
export type { NewUser, User } from './users';
