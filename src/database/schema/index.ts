import { activityEvents } from './activity';
import { auditEvents } from './audit-events';
import { jobs, jobSchedules } from './jobs';
import { lockoutAttempts } from './lockout-attempts';
import { memberships } from './memberships';
import { organizations } from './organizations';
import { outboxDeadLetters, outboxInbox, outboxMessages } from './outbox';
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
  jobs,
  jobSchedules,
  lockoutAttempts,
  memberships,
  organizations,
  outboxDeadLetters,
  outboxInbox,
  outboxMessages,
  projects,
  tasks,
  users,
};
export type { ActivityEvent, NewActivityEvent } from './activity';
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
export type { NewProject, Project } from './projects';
export type { NewTask, Task, TaskStatus } from './tasks';
export { TASK_STATUSES } from './tasks';
export type { NewUser, User } from './users';
