import { Module } from '@nestjs/common';
import { TaskSummaryClient } from './task-summary.client';
import { TaskSummaryConsumer } from './task-summary.consumer';

/**
 * Kafka-profile module holding both halves of the task-summary exchange. It is
 * imported only when KAFKA_BROKERS is set, like the inbox modules — the app's
 * default run has no broker and must not require one.
 */
@Module({
  providers: [TaskSummaryConsumer, TaskSummaryClient],
  exports: [TaskSummaryClient],
})
export class TaskSummaryModule {}
