import { Inject, Injectable } from '@nestjs/common';
import {
  KafkaConsumer,
  KafkaContext,
  KafkaCtx,
  KafkaHandler,
  KafkaHeaders,
  KafkaMessage,
} from '@nest-native/kafka';
import { type WireHeaderValue } from '@nest-native/messaging';
import { KafkaInboxConsumer } from '@nest-native/messaging/kafka';
import { loadEnv } from '../../config/env';
import { ActivityService } from '../activity/activity.service';
import {
  taskAssignedActivity,
  taskCompletedActivity,
  taskCreatedActivity,
} from '../activity/task-activity.projection';
import type { RecordActivityInput } from '../activity/activity.service';
import {
  isTaskAssignedPayload,
  isTaskCompletedPayload,
  isTaskCreatedPayload,
  OUTBOX_TOPIC_TASK_ASSIGNED,
  OUTBOX_TOPIC_TASK_COMPLETED,
  OUTBOX_TOPIC_TASK_CREATED,
} from '../outbox/outbox.constants';

// Topics/group resolved from env at class-definition time (like UserInvitedConsumer):
// the decorators take static strings, and this consumer is only registered under
// the Kafka profile via TaskActivityInboxModule + KafkaModule.forFeature.
const kafkaEnv = loadEnv().kafka;
const TOPIC_PREFIX = kafkaEnv?.topicPrefix ?? '';
const GROUP_ID = kafkaEnv?.groupId ?? 'reference-app';

const TASK_CREATED_TOPIC = `${TOPIC_PREFIX}${OUTBOX_TOPIC_TASK_CREATED}`;
const TASK_ASSIGNED_TOPIC = `${TOPIC_PREFIX}${OUTBOX_TOPIC_TASK_ASSIGNED}`;
const TASK_COMPLETED_TOPIC = `${TOPIC_PREFIX}${OUTBOX_TOPIC_TASK_COMPLETED}`;

/**
 * Kafka-profile consumer that projects the task lifecycle topics into the
 * activity feed — the consumer half mirroring {@link UserInvitedConsumer}, but
 * grouping three topics on one class (no class-level topic; each `@KafkaHandler`
 * names its own). Every handler delegates to the library's {@link
 * KafkaInboxConsumer} engine, which runs broker work outside the dedup tx and the
 * exactly-once `sideEffect` (a synchronous {@link ActivityService.record}) inside
 * it. `dlqTopic`/`source` are derived per topic exactly as the single-topic
 * consumer derives them.
 */
@Injectable()
@KafkaConsumer(undefined, { groupId: GROUP_ID })
export class TaskActivityConsumer {
  constructor(
    @Inject(KafkaInboxConsumer) private readonly inbox: KafkaInboxConsumer,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @KafkaHandler(TASK_CREATED_TOPIC)
  async onTaskCreated(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.project(
      TASK_CREATED_TOPIC,
      payload,
      headers,
      context,
      isTaskCreatedPayload,
      taskCreatedActivity,
    );
  }

  @KafkaHandler(TASK_ASSIGNED_TOPIC)
  async onTaskAssigned(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.project(
      TASK_ASSIGNED_TOPIC,
      payload,
      headers,
      context,
      isTaskAssignedPayload,
      taskAssignedActivity,
    );
  }

  @KafkaHandler(TASK_COMPLETED_TOPIC)
  async onTaskCompleted(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.project(
      TASK_COMPLETED_TOPIC,
      payload,
      headers,
      context,
      isTaskCompletedPayload,
      taskCompletedActivity,
    );
  }

  // Shared engine call: dedup-scope + DLQ derived from the topic, the payload
  // narrowed by `validate` (a failure dead-letters), and the feed write applied
  // exactly once inside the dedup transaction.
  private async project<T>(
    topic: string,
    payload: unknown,
    headers: Record<string, WireHeaderValue>,
    context: KafkaContext,
    validate: (value: unknown) => value is T,
    toActivity: (value: T) => RecordActivityInput,
  ): Promise<void> {
    await this.inbox.consume<T>({
      source: `${topic}:${GROUP_ID}`,
      context,
      headers,
      payload,
      validate,
      sideEffect: (value) => {
        this.activity.record(toActivity(value));
      },
      dlqTopic: `${topic}.DLQ`,
    });
  }
}
