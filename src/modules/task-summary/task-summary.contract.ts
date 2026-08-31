/**
 * The request-reply contract between a caller that needs a task summary and the
 * handler that answers it.
 *
 * Kept in its own file because both halves import it and neither should depend
 * on the other's module — the same discipline the outbox topics follow.
 */

/** Topic the summary is asked on. */
export const TASK_SUMMARY_TOPIC = 'task.summary.query';

/** Reply topic every instance of this app shares. */
export const TASK_SUMMARY_REPLY_TOPIC = 'task.summary.reply';

export interface TaskSummaryQuery {
  orgId: number;
}

export interface TaskSummaryAnswer {
  orgId: number;
  open: number;
  inProgress: number;
  done: number;
}

export function isTaskSummaryQuery(value: unknown): value is TaskSummaryQuery {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TaskSummaryQuery).orgId === 'number'
  );
}
