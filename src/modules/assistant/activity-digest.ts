import type { ActivityEvent } from '../../database/schema';

/**
 * Turns activity-feed rows into the two strings the assistant needs:
 *
 * - {@link buildActivityPrompt} — the instruction + bulleted digest a *real*
 *   provider reads to write its own status update.
 * - {@link buildStatusSummary} — the deterministic status update the offline
 *   mock model replays verbatim. It is derived from the same rows, so the CI
 *   stream reflects real application data (and the test can assert on it)
 *   without any network or API key.
 *
 * Both are pure functions of the rows, so they are trivial to unit-test and
 * keep the controller free of string-building logic.
 */

// Cap the digest so a long-lived feed produces a bounded prompt. The reader
// already returns rows newest-first (ordered by descending id).
const MAX_EVENTS = 20;

function recentSummaries(events: ActivityEvent[]): string[] {
  return events.slice(0, MAX_EVENTS).map((event) => event.summary);
}

export function buildActivityPrompt(
  projectName: string,
  events: ActivityEvent[],
): string {
  if (events.length === 0) {
    return (
      `You are a project assistant. Write a one-line status update for the ` +
      `project "${projectName}". There is no recent activity, so say exactly ` +
      `that.`
    );
  }
  const bullets = recentSummaries(events)
    .map((summary) => `- ${summary}`)
    .join('\n');
  return [
    `You are a project assistant. Summarize the recent activity for the ` +
      `project "${projectName}" into a short status update for the team.`,
    '',
    'Recent activity (newest first):',
    bullets,
  ].join('\n');
}

export function buildStatusSummary(
  projectName: string,
  events: ActivityEvent[],
): string {
  if (events.length === 0) {
    return `Status update for ${projectName}: no recent activity to report.`;
  }
  const count = events.length;
  const header =
    `Status update for ${projectName}: ${count} recent ` +
    `${count === 1 ? 'event' : 'events'}.`;
  const bullets = recentSummaries(events).map((summary) => `- ${summary}`);
  return [header, ...bullets].join('\n');
}
