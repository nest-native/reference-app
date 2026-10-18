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
 * the in-process handler and the broker inbox consumers so every profile writes
 * the SAME `summary` and `dedupKey`. The `dedupKey` is the event's
 * `x-idempotency-key` (`<topic>:<orgId>:<taskId>[:<assigneeId>]`, also its Kafka
 * message key) followed by `eventId`, the message id the consumers' inboxes
 * deduplicate on (`x-event-id`). So each event gets one feed row whatever the
 * transport or the redeliveries, and a transition that happens again — a task
 * assigned back to an earlier assignee, or completed again after it was
 * reopened — is a new event with a row of its own.
 */
export function taskCreatedActivity(
  payload: TaskCreatedPayload,
  eventId: string,
): RecordActivityInput {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    type: OUTBOX_TOPIC_TASK_CREATED,
    actorUserId: payload.createdBy,
    summary: `Task "${payload.title}" created`,
    dedupKey: `${OUTBOX_TOPIC_TASK_CREATED}:${payload.orgId}:${payload.taskId}:${eventId}`,
  };
}

export function taskAssignedActivity(
  payload: TaskAssignedPayload,
  eventId: string,
): RecordActivityInput {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    type: OUTBOX_TOPIC_TASK_ASSIGNED,
    actorUserId: payload.assignedBy,
    summary: `Task #${payload.taskId} assigned to user #${payload.assigneeId}`,
    dedupKey: `${OUTBOX_TOPIC_TASK_ASSIGNED}:${payload.orgId}:${payload.taskId}:${payload.assigneeId}:${eventId}`,
  };
}

export function taskCompletedActivity(
  payload: TaskCompletedPayload,
  eventId: string,
): RecordActivityInput {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId,
    type: OUTBOX_TOPIC_TASK_COMPLETED,
    actorUserId: payload.completedBy,
    summary: `Task #${payload.taskId} completed`,
    dedupKey: `${OUTBOX_TOPIC_TASK_COMPLETED}:${payload.orgId}:${payload.taskId}:${eventId}`,
  };
}
