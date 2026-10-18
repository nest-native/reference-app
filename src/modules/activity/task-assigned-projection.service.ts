import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { JobsService } from '@nest-native/jobs';
import type { SqliteJobStore } from '@nest-native/jobs/sqlite';
import { loadEnv } from '../../config/env';
import type { TaskAssignedPayload } from '../outbox/outbox.constants';
import { JOB_TASK_ASSIGNMENT_REMINDER } from '../reminders/reminders.constants';
import { ActivityService } from './activity.service';
import { taskAssignedActivity } from './task-activity.projection';

/**
 * The one place a `task.assigned` delivery is applied — shared, through
 * {@link import('../inbox/task-activity.projections').TaskActivityProjections},
 * by the in-process {@link import('../outbox/activity.handler').ActivityHandler}
 * and the Kafka and RabbitMQ consumers — so the feed row and the deferred
 * assignment-reminder job always commit (or roll back) together:
 *
 *   - Delivered, it runs inside the transaction that records the delivery in
 *     the consumer's inbox (`processInTransaction()`); `@Transactional()`
 *     (propagation REQUIRED) joins it, so the inbox record, the feed row, and
 *     the job row are one atomic commit.
 *   - Called on its own, with no ambient transaction, the decorator opens one
 *     around the pair.
 *
 * Each assignment gets its own reminder: the dedup key carries the event's
 * message id, so a task assigned back to an earlier assignee is reminded again.
 * Past the consumer's inbox, redelivery of one event can never schedule a
 * second reminder, via two independent layers:
 *
 *   1. The feed's `(org_id, dedup_key)` unique index — `record` returns
 *      `undefined` for an already-projected event and the enqueue is skipped
 *      entirely (this holds even after the job completed and released its key).
 *   2. The job's `uniqueKey` (= the same dedup key) — while a reminder for this
 *      assignment is pending/processing, a concurrent enqueue is a no-op that
 *      returns the existing row.
 */
@Injectable()
export class TaskAssignedProjection {
  // Read at construction, not module load, so test profiles that set
  // TASK_REMINDER_DELAY_MS before bootstrapping the app see their value.
  private readonly reminderDelayMs = loadEnv().taskReminderDelayMs;

  constructor(
    @Inject(ActivityService) private readonly activity: ActivityService,
    // Typed with the SQLite store so `enqueue` returns the row synchronously
    // (callable inside this synchronous @Transactional body).
    @Inject(JobsService) private readonly jobs: JobsService<SqliteJobStore>,
  ) {}

  // Declared Promise<void> for the same reason as OrganizationOnboardingService:
  // @Transactional() imposes a Promise on the caller's view even though the
  // better-sqlite3 body runs synchronously (so it is also safe inside the
  // inbox's synchronous dedup transaction, where it simply joins).
  @Transactional()
  apply(payload: TaskAssignedPayload, eventId: string): Promise<void> {
    const activity = taskAssignedActivity(payload, eventId);
    const inserted = this.activity.record(activity);
    if (inserted) {
      this.jobs.enqueue({
        name: JOB_TASK_ASSIGNMENT_REMINDER,
        payload,
        delayMs: this.reminderDelayMs,
        uniqueKey: activity.dedupKey,
      });
    }
    return undefined as unknown as Promise<void>;
  }
}
