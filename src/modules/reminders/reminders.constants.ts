/**
 * Job name for the deferred assignment reminder. The payload on the job row is
 * the `task.assigned` event payload itself ({@link
 * import('../outbox/outbox.constants').TaskAssignedPayload}) — one contract,
 * defined once, validated by the same Zod guard on both the event and the job
 * side.
 */
export const JOB_TASK_ASSIGNMENT_REMINDER = 'task.assignment-reminder' as const;

/** Audit action the reminder handler records when the reminder fires. */
export const AUDIT_ACTION_TASK_REMINDER_SENT = 'task.reminder.sent' as const;

/**
 * Job name for the nightly stale-task sweep. Unlike the assignment reminder
 * (enqueued by a projection when a task is assigned), this one is enqueued by
 * `@nest-native/jobs`' schedule engine from a `job_schedules` row — see
 * {@link import('./stale-task-schedule.setup').StaleTaskScheduleSetup}.
 */
export const JOB_STALE_TASK_SWEEP = 'tasks.stale-sweep' as const;

/** Schedule identity (the `job_schedules.name` the boot-time upsert keys on). */
export const SCHEDULE_STALE_TASK_SWEEP = 'nightly-stale-task-sweep' as const;

/** Audit action the sweep records for each task it flags. */
export const AUDIT_ACTION_TASK_STALE_FLAGGED = 'task.stale.flagged' as const;

/** A task still open this many days after creation is considered stale. */
export const STALE_TASK_AFTER_DAYS = 14;
