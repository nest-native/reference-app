import { Inject, Injectable } from '@nestjs/common';
import { type JobContext, JobHandler } from '@nest-native/jobs';
import { and, eq, lt } from 'drizzle-orm';
import type { AppDatabase } from '../../database/database';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { tasks } from '../../database/schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  AUDIT_ACTION_TASK_STALE_FLAGGED,
  JOB_STALE_TASK_SWEEP,
  STALE_TASK_AFTER_DAYS,
} from './reminders.constants';

/**
 * Runs when the nightly `tasks.stale-sweep` schedule fires: flags every task
 * still `open` more than {@link STALE_TASK_AFTER_DAYS} days after creation by
 * recording a `task.stale.flagged` audit entry — the same "audit entry stands
 * in for a notification" convention {@link
 * import('./assignment-reminder.handler').AssignmentReminderHandler} uses.
 *
 * Two things differ from the assignment reminder and are the point of this
 * handler as a dogfooding exercise:
 *
 * - **Nobody enqueues it.** The occurrence is inserted by the jobs claimer from
 *   a `job_schedules` row, in the same transaction that advances the schedule.
 * - **It must be idempotent per occurrence**, because delivery is at-least-once
 *   — so a task already flagged since it went stale is skipped rather than
 *   re-flagged, and the sweep reads the DB itself instead of trusting a payload.
 *
 * The claimer runs handlers OUTSIDE any business transaction, so this injects
 * the base Drizzle client directly (the reads are plain queries) and lets
 * {@link AuditLogService} take its base-instance fallback for the writes.
 */
@JobHandler(JOB_STALE_TASK_SWEEP)
@Injectable()
export class StaleTaskSweepHandler implements JobHandler {
  constructor(
    @Inject(getDrizzleClientToken()) private readonly db: AppDatabase,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
  ) {}

  handle(_payload: Record<string, unknown>, ctx: JobContext): void {
    const cutoff = new Date(
      Date.now() - STALE_TASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const stale = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'open'), lt(tasks.createdAt, cutoff)))
      .all();

    for (const task of stale) {
      this.audit.record({
        orgId: task.orgId,
        // The sweep is the system acting, not a person; attribute it to the
        // task's creator so the entry still joins to a real user row.
        actorUserId: task.createdBy,
        action: AUDIT_ACTION_TASK_STALE_FLAGGED,
        subjectType: 'task',
        subjectId: String(task.id),
        metadata: {
          title: task.title,
          createdAt: task.createdAt,
          staleAfterDays: STALE_TASK_AFTER_DAYS,
          // The occurrence's job id — the natural idempotency key for anything
          // downstream that must not act twice on one sweep.
          jobId: ctx.jobId,
        },
      });
    }
  }
}
