import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type OutboxHandlerResult,
  OutboxRegistry,
} from '@nest-native/messaging/in-process';
import { ActivityService } from '../activity/activity.service';
import {
  taskCompletedActivity,
  taskCreatedActivity,
} from '../activity/task-activity.projection';
import { TaskAssignedProjection } from '../activity/task-assigned-projection.service';
import {
  isTaskAssignedPayload,
  isTaskCompletedPayload,
  isTaskCreatedPayload,
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
} from './outbox.constants';

/**
 * In-process (default profile) counterpart to {@link UserInvitedHandler}: it
 * routes the task lifecycle events the claimer drains into the activity feed.
 * Each topic gets its own registry handler that validates the payload (a malformed
 * one is a permanent failure the claimer marks `failed`) and applies the shared
 * projection — `task.assigned` through {@link TaskAssignedProjection}, which
 * also schedules the assignment reminder in the same transaction. The feed's
 * own `(org_id, dedup_key)` unique index keeps a re-tick idempotent, so this
 * handler needs no dedup bookkeeping of its own.
 */
@Injectable()
export class ActivityHandler implements OnModuleInit {
  constructor(
    @Inject(OutboxRegistry) private readonly registry: OutboxRegistry,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TaskAssignedProjection)
    private readonly taskAssigned: TaskAssignedProjection,
  ) {}

  onModuleInit(): void {
    this.registry.register(OUTBOX_TOPIC_TASK_CREATED, (payload) =>
      this.onCreated(payload),
    );
    this.registry.register(OUTBOX_TOPIC_TASK_ASSIGNED, (payload) =>
      this.onAssigned(payload),
    );
    this.registry.register(OUTBOX_TOPIC_TASK_COMPLETED, (payload) =>
      this.onCompleted(payload),
    );
  }

  private onCreated(payload: Record<string, unknown>): OutboxHandlerResult {
    if (!isTaskCreatedPayload(payload)) {
      throw new Error('task.created: malformed payload');
    }
    this.activity.record(taskCreatedActivity(payload));
    return 'completed';
  }

  private async onAssigned(
    payload: Record<string, unknown>,
  ): Promise<OutboxHandlerResult> {
    if (!isTaskAssignedPayload(payload)) {
      throw new Error('task.assigned: malformed payload');
    }
    await this.taskAssigned.apply(payload);
    return 'completed';
  }

  private onCompleted(payload: Record<string, unknown>): OutboxHandlerResult {
    if (!isTaskCompletedPayload(payload)) {
      throw new Error('task.completed: malformed payload');
    }
    this.activity.record(taskCompletedActivity(payload));
    return 'completed';
  }
}
