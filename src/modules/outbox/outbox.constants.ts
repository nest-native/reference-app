export const OUTBOX_REGISTRY = Symbol.for('reference-app:outbox-registry');
export const FAKE_EMAIL_TRANSPORT = Symbol.for('reference-app:fake-email-transport');

export const OUTBOX_TOPIC_USER_INVITED = 'user.invited' as const;
export const OUTBOX_TOPIC_TASK_CREATED = 'task.created' as const;
export const OUTBOX_TOPIC_TASK_ASSIGNED = 'task.assigned' as const;
export const OUTBOX_TOPIC_TASK_COMPLETED = 'task.completed' as const;

export type OutboxTopic =
  | typeof OUTBOX_TOPIC_USER_INVITED
  | typeof OUTBOX_TOPIC_TASK_CREATED
  | typeof OUTBOX_TOPIC_TASK_ASSIGNED
  | typeof OUTBOX_TOPIC_TASK_COMPLETED;

export interface UserInvitedPayload {
  invitedEmail: string;
  invitedUserId: number;
  invitedByUserId: number;
  orgId: number;
  projectId: number;
}

export interface TaskCreatedPayload {
  taskId: number;
  orgId: number;
  projectId: number;
  title: string;
  createdBy: number;
}

export interface TaskAssignedPayload {
  taskId: number;
  orgId: number;
  projectId: number;
  assigneeId: number;
  assignedBy: number;
}

export interface TaskCompletedPayload {
  taskId: number;
  orgId: number;
  projectId: number;
  completedBy: number;
}

/**
 * Runtime type guard for {@link UserInvitedPayload}. Single-sourced here so the
 * producer-side handler and the consumer-side inbox validate the `user.invited`
 * contract against the same predicate — the wire shape is defined once.
 */
export function isUserInvitedPayload(
  value: unknown,
): value is UserInvitedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<UserInvitedPayload>;
  return (
    typeof p.invitedEmail === 'string' &&
    typeof p.invitedUserId === 'number' &&
    typeof p.invitedByUserId === 'number' &&
    typeof p.orgId === 'number' &&
    typeof p.projectId === 'number'
  );
}

/** Shared shape of every task lifecycle event — the entity + tenant coordinates. */
function hasTaskCoordinates(
  value: unknown,
): value is { taskId: number; orgId: number; projectId: number } {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as { taskId?: unknown; orgId?: unknown; projectId?: unknown };
  return (
    typeof p.taskId === 'number' &&
    typeof p.orgId === 'number' &&
    typeof p.projectId === 'number'
  );
}

/** Runtime type guard for {@link TaskCreatedPayload}. */
export function isTaskCreatedPayload(
  value: unknown,
): value is TaskCreatedPayload {
  if (!hasTaskCoordinates(value)) return false;
  const p = value as Partial<TaskCreatedPayload>;
  return typeof p.title === 'string' && typeof p.createdBy === 'number';
}

/** Runtime type guard for {@link TaskAssignedPayload}. */
export function isTaskAssignedPayload(
  value: unknown,
): value is TaskAssignedPayload {
  if (!hasTaskCoordinates(value)) return false;
  const p = value as Partial<TaskAssignedPayload>;
  return typeof p.assigneeId === 'number' && typeof p.assignedBy === 'number';
}

/** Runtime type guard for {@link TaskCompletedPayload}. */
export function isTaskCompletedPayload(
  value: unknown,
): value is TaskCompletedPayload {
  if (!hasTaskCoordinates(value)) return false;
  const p = value as Partial<TaskCompletedPayload>;
  return typeof p.completedBy === 'number';
}
