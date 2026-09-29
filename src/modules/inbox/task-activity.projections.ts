import { Inject, Injectable } from '@nestjs/common';
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
  type TaskAssignedPayload,
  type TaskCompletedPayload,
  type TaskCreatedPayload,
} from '../outbox/outbox.constants';

/**
 * How one task lifecycle event reaches the activity feed: the payload guard
 * (a failure dead-letters the message) and the projection write, which runs
 * exactly once inside the inbox's dedup transaction — synchronous and
 * DB-only, as the SQLite store requires. `apply` is a method, not a function
 * property, so a projection of one payload type can sit in a map of any.
 */
export interface TaskActivityProjection<T> {
  validate(payload: unknown): payload is T;
  apply(payload: T): void;
}

/**
 * The task lifecycle projections the broker profiles share. The Kafka consumer
 * binds one handler per topic to them; the RabbitMQ consumer receives all three
 * topics on one queue and picks the projection by routing key. Either way the
 * feed is written by the same code.
 */
@Injectable()
export class TaskActivityProjections {
  readonly taskCreated: TaskActivityProjection<TaskCreatedPayload>;
  readonly taskAssigned: TaskActivityProjection<TaskAssignedPayload>;
  readonly taskCompleted: TaskActivityProjection<TaskCompletedPayload>;
  /** Every projection by its (unprefixed) outbox topic. */
  readonly byTopic: ReadonlyMap<string, TaskActivityProjection<unknown>>;

  constructor(
    @Inject(ActivityService) activity: ActivityService,
    @Inject(TaskAssignedProjection) taskAssigned: TaskAssignedProjection,
  ) {
    this.taskCreated = {
      validate: isTaskCreatedPayload,
      apply: (payload) => {
        activity.record(taskCreatedActivity(payload));
      },
    };
    this.taskAssigned = {
      validate: isTaskAssignedPayload,
      // Joins the dedup transaction (synchronously, on better-sqlite3) and
      // enqueues the assignment-reminder job atomically with the feed row; the
      // `void` discards the Promise the @Transactional signature imposes.
      apply: (payload) => {
        void taskAssigned.apply(payload);
      },
    };
    this.taskCompleted = {
      validate: isTaskCompletedPayload,
      apply: (payload) => {
        activity.record(taskCompletedActivity(payload));
      },
    };
    this.byTopic = new Map<string, TaskActivityProjection<unknown>>([
      [OUTBOX_TOPIC_TASK_CREATED, this.taskCreated],
      [OUTBOX_TOPIC_TASK_ASSIGNED, this.taskAssigned],
      [OUTBOX_TOPIC_TASK_COMPLETED, this.taskCompleted],
    ]);
  }
}
