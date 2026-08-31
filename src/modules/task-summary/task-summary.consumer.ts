import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { KafkaConsumer, KafkaHandler, KafkaMessage } from '@nest-native/kafka';
import { and, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/database';
import { tasks } from '../../database/schema';
import { loadEnv } from '../../config/env';
import {
  isTaskSummaryQuery,
  TASK_SUMMARY_TOPIC,
  TaskSummaryAnswer,
} from './task-summary.contract';

// Topic resolved at class-definition time like the other Kafka-profile
// consumers: the decorators take static strings.
const kafkaEnv = loadEnv().kafka;
const TOPIC = `${kafkaEnv?.topicPrefix ?? ''}${TASK_SUMMARY_TOPIC}`;
const GROUP_ID = `${kafkaEnv?.groupId ?? 'reference-app'}-task-summary`;

/**
 * Answers a task summary over request-reply.
 *
 * Everything else this app publishes is an event — emitted through the outbox
 * and forgotten. This one is a *question*: the caller cannot continue without
 * the answer, which is the only shape request-reply is for. `reply: true` is the
 * whole opt-in; the handler's return value is the reply body, and the address
 * comes from the request's own headers.
 *
 * The count is scoped to the org in the query. Tenancy is not optional here:
 * a summary that leaked another org's counts would be a data-isolation bug, so
 * the org filter is part of the query and is asserted in the spec.
 */
@Injectable()
@KafkaConsumer(TOPIC, { groupId: GROUP_ID })
export class TaskSummaryConsumer {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  @KafkaHandler(TOPIC, { reply: true })
  async summarize(@KafkaMessage() query: unknown): Promise<TaskSummaryAnswer> {
    if (!isTaskSummaryQuery(query)) {
      // A malformed question has no answer, and no redelivery can fix it.
      //
      // The exception type matters here, and not in the way it does for a
      // fire-and-forget handler. The error mapper maps a plain `Error` to
      // `'retry'`, which by contract sends NO reply — so a caller waits out the
      // full timeout for a message that will never be answerable, and learns
      // "unknown outcome" for something that is definitively known. A 4xx maps
      // to `'commit'`: the offset advances and the failure travels back as an
      // error reply, so the caller learns immediately.
      throw new BadRequestException(
        'task summary query must carry a numeric orgId',
      );
    }

    const counts = await this.db
      .select({
        status: tasks.status,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(tasks)
      .where(eq(tasks.orgId, query.orgId))
      .groupBy(tasks.status);

    const of = (status: string): number =>
      Number(counts.find(row => row.status === status)?.count ?? 0);

    return {
      orgId: query.orgId,
      open: of('open'),
      inProgress: of('in_progress'),
      done: of('done'),
    };
  }
}
