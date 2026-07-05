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
