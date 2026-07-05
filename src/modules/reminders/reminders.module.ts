import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AssignmentReminderHandler } from './assignment-reminder.handler';

/**
 * Deferred work, built on `@nest-native/jobs`. This module owns the execution
 * half of the assignment reminder: the `@JobHandler` the jobs claimer
 * dispatches to (discovered at bootstrap — registering it as a provider is the
 * whole wiring). The scheduling half lives in the activity module's {@link
 * import('../activity/task-assigned-projection.service').TaskAssignedProjection},
 * which enqueues the job in the same transaction as the `task.assigned` feed
 * row.
 */
@Module({
  imports: [AuditLogModule],
  providers: [AssignmentReminderHandler],
})
export class RemindersModule {}
