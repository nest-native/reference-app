import { Inject, Injectable } from '@nestjs/common';
import {
  type JobContext,
  JobHandler,
  PermanentError,
} from '@nest-native/jobs';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isTaskAssignedPayload } from '../outbox/outbox.constants';
import {
  AUDIT_ACTION_TASK_REMINDER_SENT,
  JOB_TASK_ASSIGNMENT_REMINDER,
} from './reminders.constants';

/**
 * Runs when a `task.assignment-reminder` job comes due: records the reminder as
 * a `task.reminder.sent` audit entry (this app's stand-in for a notification —
 * the same role {@link FakeEmailTransport} plays for invitations). The claimer
 * executes handlers OUTSIDE any business transaction, so the write goes through
 * {@link AuditLogService}'s base-instance fallback — synchronous and DB-only,
 * like the other handlers' effects. A malformed payload can never succeed →
 * {@link PermanentError} fails the job without burning retries.
 */
@JobHandler(JOB_TASK_ASSIGNMENT_REMINDER)
@Injectable()
export class AssignmentReminderHandler implements JobHandler {
  constructor(
    @Inject(AuditLogService) private readonly audit: AuditLogService,
  ) {}

  handle(payload: Record<string, unknown>, ctx: JobContext): void {
    if (!isTaskAssignedPayload(payload)) {
      throw new PermanentError(
        `${JOB_TASK_ASSIGNMENT_REMINDER}: malformed payload`,
      );
    }
    this.audit.record({
      orgId: payload.orgId,
      actorUserId: payload.assignedBy,
      action: AUDIT_ACTION_TASK_REMINDER_SENT,
      subjectType: 'task',
      subjectId: String(payload.taskId),
      metadata: {
        assigneeId: payload.assigneeId,
        projectId: payload.projectId,
        // The job id is the natural idempotency key for this side effect.
        jobId: ctx.jobId,
        attempt: ctx.attempt,
      },
    });
  }
}
