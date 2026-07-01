import {
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
  type TaskAssignedPayload,
  type TaskCompletedPayload,
  type TaskCreatedPayload,
} from '../outbox/outbox.constants';
import type { RecordActivityInput } from './activity.service';

/**
 * Pure projection from a task lifecycle event to an activity-feed row, shared by
 * the in-process handler and the Kafka inbox consumer so both profiles write the
 * SAME `summary` and `dedupKey`. The `dedupKey` mirrors the event's outbox
 * idempotency key (`<topic>:<orgId>:<taskId>[:<assigneeId>]`), which is also the
 * Kafka message key the inbox dedups on — one logical event maps to one feed row
 * regardless of transport or redelivery.
 */
export function taskCreatedActivity(
  payload: TaskCreatedPayload,
): RecordActivityInput {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    type: OUTBOX_TOPIC_TASK_CREATED,
    actorUserId: payload.createdBy,
    summary: `Task "${payload.title}" created`,
    dedupKey: `${OUTBOX_TOPIC_TASK_CREATED}:${payload.orgId}:${payload.taskId}`,
  };
}

export function taskAssignedActivity(
  payload: TaskAssignedPayload,
): RecordActivityInput {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    type: OUTBOX_TOPIC_TASK_ASSIGNED,
    actorUserId: payload.assignedBy,
    summary: `Task #${payload.taskId} assigned to user #${payload.assigneeId}`,
    dedupKey: `${OUTBOX_TOPIC_TASK_ASSIGNED}:${payload.orgId}:${payload.taskId}:${payload.assigneeId}`,
  };
}

export function taskCompletedActivity(
  payload: TaskCompletedPayload,
): RecordActivityInput {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    type: OUTBOX_TOPIC_TASK_COMPLETED,
    actorUserId: payload.completedBy,
    summary: `Task #${payload.taskId} completed`,
    dedupKey: `${OUTBOX_TOPIC_TASK_COMPLETED}:${payload.orgId}:${payload.taskId}`,
  };
}
