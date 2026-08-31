import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  KafkaReplyRemoteError,
  KafkaReplyTimeoutError,
  KafkaRequestReplyService,
} from '@nest-native/kafka';
import { loadEnv } from '../../config/env';
import {
  TASK_SUMMARY_TOPIC,
  TaskSummaryAnswer,
  TaskSummaryQuery,
} from './task-summary.contract';

const kafkaEnv = loadEnv().kafka;
const TOPIC = `${kafkaEnv?.topicPrefix ?? ''}${TASK_SUMMARY_TOPIC}`;

/**
 * The asking half. Registered only under the Kafka profile, so nothing in the
 * default (broker-less) run depends on it.
 */
@Injectable()
export class TaskSummaryClient {
  private readonly logger = new Logger(TaskSummaryClient.name);

  // Injected by explicit token, not by type. The test runner (tsx/esbuild)
  // does not implement `emitDecoratorMetadata` even though tsconfig enables it,
  // so type-only constructor injection silently resolves to `undefined` here
  // rather than failing at boot. The rest of the app injects the same way for
  // the same reason.
  constructor(
    @Inject(KafkaRequestReplyService)
    private readonly requests: KafkaRequestReplyService,
  ) {}

  /**
   * Ask for an org's task summary and wait for the answer.
   *
   * Returns `undefined` when the outcome is genuinely unknown — a timeout means
   * the request may still be processed, so callers must not read it as "zero
   * tasks". The distinction is the whole reason this returns an optional rather
   * than an empty summary.
   */
  async summarize(
    query: TaskSummaryQuery,
  ): Promise<TaskSummaryAnswer | undefined> {
    try {
      const reply = await this.requests.request<TaskSummaryAnswer>({
        topic: TOPIC,
        message: { value: JSON.stringify(query) },
      });
      return reply.value;
    } catch (error) {
      if (error instanceof KafkaReplyTimeoutError) {
        this.logger.warn(
          `Task summary for org ${query.orgId} timed out — outcome unknown.`,
        );
        return undefined;
      }
      if (error instanceof KafkaReplyRemoteError) {
        // The far side answered, and the answer was a failure. That is a real
        // reply, not a lost message, so it is worth distinguishing in the log.
        this.logger.warn(
          `Task summary for org ${query.orgId} was rejected: ${error.message}`,
        );
        return undefined;
      }
      throw error;
    }
  }
}
