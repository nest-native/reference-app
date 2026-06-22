import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import type { AppDatabase } from '../../database/database';
import { inboxEvents } from '../../database/schema';

/**
 * The DB side effect to apply exactly once for a message. It runs INSIDE the
 * dedup transaction and MUST be synchronous (better-sqlite3 runs
 * `@Transactional()` bodies synchronously — see the class doc): no `await`. If
 * it throws, the whole transaction — including the dedup row — rolls back, so
 * the message is safely reprocessed on redelivery.
 */
export type InboxSideEffect = () => void;

export type RunOnceOutcome = 'processed' | 'duplicate';

/**
 * better-sqlite3 surfaces a unique-constraint violation as a `SqliteError` with
 * `code === 'SQLITE_CONSTRAINT_UNIQUE'`. We match on the code (not the message)
 * so the predicate is stable across driver versions.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * The idempotent inbox: a synchronous, DB-only dedup primitive.
 *
 * `runOnce` is the entire consumer-side exactly-once mechanism. It is NOT a
 * poller or a claimer — it is invoked by a Kafka consumer wrapper for each
 * delivered message, OUTSIDE of which all async broker work (parse, ack, DLQ)
 * happens. The transaction does two things atomically:
 *
 *   1. INSERT the dedup row for `(source, messageKey)`. The unique index makes a
 *      second delivery of the same key violate the constraint → `'duplicate'`,
 *      and the handler is skipped.
 *   2. On a fresh key, run the synchronous `handler` side effect in the SAME
 *      transaction. If it throws, the row insert rolls back too — so a failed
 *      delivery leaves no dedup row and the redelivery reprocesses cleanly.
 *
 * HARD CONSTRAINT: the body is synchronous. The app runs `@nestjs-cls/
 * transactional` with the Drizzle better-sqlite3 adapter in sync mode, where a
 * `@Transactional()` body cannot contain `await`. The method is declared
 * `Promise<...>` (the decorator always returns a Promise) and the synchronous
 * return value is cast to that Promise — the same bridge used by
 * `OrganizationOnboardingService.inviteUser`.
 */
@Injectable()
export class InboxService {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  @Transactional()
  runOnce(
    messageKey: string,
    source: string,
    handler: InboxSideEffect,
  ): Promise<RunOnceOutcome> {
    const now = new Date().toISOString();
    try {
      this.db
        .insert(inboxEvents)
        .values({
          id: randomUUID(),
          messageKey,
          source,
          status: 'processed',
          processedAt: now,
          createdAt: now,
        })
        .run();
    } catch (error) {
      // Already processed: the dedup row exists from a prior delivery. Skip the
      // side effect and commit nothing new.
      if (isUniqueViolation(error)) {
        return 'duplicate' as unknown as Promise<RunOnceOutcome>;
      }
      throw error;
    }

    // Fresh message: apply the side effect in the same transaction. A throw
    // here rolls back the dedup row above (safe redelivery).
    handler();
    return 'processed' as unknown as Promise<RunOnceOutcome>;
  }
}
