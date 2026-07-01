import { Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../database/database';
import { type ActivityEvent, activityEvents } from '../../database/schema';

export interface RecordActivityInput {
  orgId: number;
  projectId: number | null;
  type: string;
  actorUserId: number | null;
  summary: string;
  dedupKey: string;
}

/**
 * Writes and reads the activity feed read-model. `record` is the exactly-once
 * sink both messaging profiles converge on: the in-process outbox handler and the
 * Kafka inbox consumer each call it with a payload-derived `dedupKey`, and the
 * `(org_id, dedup_key)` unique index makes a duplicate delivery a silent no-op
 * (`onConflictDoNothing`). It is a synchronous, DB-only write so it is safe inside
 * the better-sqlite3 sync transaction the inbox opens around it.
 */
@Injectable()
export class ActivityService {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  record(input: RecordActivityInput): ActivityEvent | undefined {
    return this.db
      .insert(activityEvents)
      .values({
        orgId: input.orgId,
        projectId: input.projectId,
        type: input.type,
        actorUserId: input.actorUserId,
        summary: input.summary,
        dedupKey: input.dedupKey,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({
        target: [activityEvents.orgId, activityEvents.dedupKey],
      })
      .returning()
      .get();
  }

  list(orgId: number, projectId: number): ActivityEvent[] {
    return this.db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.orgId, orgId),
          eq(activityEvents.projectId, projectId),
        ),
      )
      .orderBy(desc(activityEvents.id))
      .all();
  }
}
