import { Inject, Injectable } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import {
  NonRetryableMessageError,
  OnOutboxMessage,
  type OutboxHandlerContext,
} from '@nestjs/outbox';
import type { AppDatabase } from '../../database/database';
import { TaskActivityProjections } from '../inbox/task-activity.projections';
import {
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
} from './outbox.constants';

/**
 * In-process (default profile) counterpart to {@link UserInvitedHandler}: it
 * projects the task lifecycle events the relay delivers into the activity
 * feed, through the same {@link TaskActivityProjections} the broker consumers
 * apply — `task.assigned` also schedules the assignment reminder. The handler's
 * inbox record, the feed row and the reminder job commit in one transaction
 * (`ctx.processInTransaction()`), so a redelivery skips the work and a failure
 * leaves nothing behind. A malformed payload can never succeed: it is
 * dead-lettered at once instead of retried.
 */
@Injectable()
export class ActivityHandler {
  constructor(
    @InjectTransaction() private readonly db: AppDatabase,
    @Inject(TaskActivityProjections)
    private readonly projections: TaskActivityProjections,
  ) {}

  // Declared Promise<void>: @Transactional() hands the caller a Promise even
  // though the better-sqlite3 body runs synchronously, the way the app's other
  // @Transactional() methods do.
  @OnOutboxMessage(
    [
      OUTBOX_TOPIC_TASK_CREATED,
      OUTBOX_TOPIC_TASK_ASSIGNED,
      OUTBOX_TOPIC_TASK_COMPLETED,
    ],
    { consumer: 'activity-feed' },
  )
  @Transactional()
  project(
    payload: unknown,
    ctx: OutboxHandlerContext<AppDatabase>,
  ): Promise<void> {
    const projection = this.projections.byTopic.get(ctx.message.topic);
    if (!projection?.validate(payload)) {
      throw new NonRetryableMessageError(
        `${ctx.message.topic}: malformed payload`,
      );
    }
    ctx.processInTransaction(this.db, () =>
      projection.apply(payload, ctx.message.id),
    );
    return undefined as unknown as Promise<void>;
  }
}
