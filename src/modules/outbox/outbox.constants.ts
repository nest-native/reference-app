import { z } from 'zod';

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

// Each event payload contract is defined ONCE as a Zod schema. Everything else
// derives from it: the TS types below via `z.infer`, the runtime guards via
// `safeParse`, and the AsyncAPI catalog (src/modules/events-catalog) by passing
// these schemas directly to `@AsyncApiMessage` — no hand-written JSON Schema to
// keep in sync. The ids are integer primary keys, hence `z.int()`.

/** Emitted when a user is invited to an organization project. */
export const userInvitedPayloadSchema = z
  .object({
    invitedEmail: z.email().describe('Email address the invitation was sent to'),
    invitedUserId: z.int().describe('Id of the newly-invited user'),
    invitedByUserId: z.int().describe('Id of the user who sent the invitation'),
    orgId: z.int().describe('Tenant (organization) the invitation belongs to'),
    projectId: z.int().describe('Project the user was invited to'),
  })
  .meta({
    title: 'UserInvitedPayload',
    description: 'Emitted when a user is invited to an organization project.',
  });

/** Emitted when a task is created in a project. */
export const taskCreatedPayloadSchema = z
  .object({
    taskId: z.int().describe('Id of the created task'),
    orgId: z.int().describe('Tenant (organization) the task belongs to'),
    projectId: z.int().describe('Project the task belongs to'),
    title: z.string().describe('Human-readable task title'),
    createdBy: z.int().describe('Id of the user who created the task'),
  })
  .meta({
    title: 'TaskCreatedPayload',
    description: 'Emitted when a task is created in a project.',
  });

/** Emitted when a task is assigned to a user. */
export const taskAssignedPayloadSchema = z
  .object({
    taskId: z.int().describe('Id of the assigned task'),
    orgId: z.int().describe('Tenant (organization) the task belongs to'),
    projectId: z.int().describe('Project the task belongs to'),
    assigneeId: z.int().describe('Id of the user the task was assigned to'),
    assignedBy: z.int().describe('Id of the user who assigned the task'),
  })
  .meta({
    title: 'TaskAssignedPayload',
    description: 'Emitted when a task is assigned to a user.',
  });

/** Emitted when a task is marked complete. */
export const taskCompletedPayloadSchema = z
  .object({
    taskId: z.int().describe('Id of the completed task'),
    orgId: z.int().describe('Tenant (organization) the task belongs to'),
    projectId: z.int().describe('Project the task belongs to'),
    completedBy: z.int().describe('Id of the user who completed the task'),
  })
  .meta({
    title: 'TaskCompletedPayload',
    description: 'Emitted when a task is marked complete.',
  });

export type UserInvitedPayload = z.infer<typeof userInvitedPayloadSchema>;
export type TaskCreatedPayload = z.infer<typeof taskCreatedPayloadSchema>;
export type TaskAssignedPayload = z.infer<typeof taskAssignedPayloadSchema>;
export type TaskCompletedPayload = z.infer<typeof taskCompletedPayloadSchema>;

/**
 * Runtime type guard for {@link UserInvitedPayload}. Single-sourced from the
 * Zod schema so the producer-side handler and the consumer-side inbox validate
 * the `user.invited` contract against the same definition — the wire shape is
 * defined once. (Zod's default object mode tolerates unknown extra keys, so
 * payloads with additive fields still pass, as before.)
 */
export function isUserInvitedPayload(
  value: unknown,
): value is UserInvitedPayload {
  return userInvitedPayloadSchema.safeParse(value).success;
}

/** Runtime type guard for {@link TaskCreatedPayload}. */
export function isTaskCreatedPayload(
  value: unknown,
): value is TaskCreatedPayload {
  return taskCreatedPayloadSchema.safeParse(value).success;
}

/** Runtime type guard for {@link TaskAssignedPayload}. */
export function isTaskAssignedPayload(
  value: unknown,
): value is TaskAssignedPayload {
  return taskAssignedPayloadSchema.safeParse(value).success;
}

/** Runtime type guard for {@link TaskCompletedPayload}. */
export function isTaskCompletedPayload(
  value: unknown,
): value is TaskCompletedPayload {
  return taskCompletedPayloadSchema.safeParse(value).success;
}
