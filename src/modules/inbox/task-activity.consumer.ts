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
  taskCompletedActivity,
  taskCreatedActivity,
} from '../activity/task-activity.projection';
import { TaskAssignedProjection } from '../activity/task-assigned-projection.service';
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
 * KafkaInboxConsumer} engine, which runs broker work outside the dedup tx and
 * the exactly-once `sideEffect` (synchronous + DB-only) inside it. For
 * `task.assigned` the side effect is the shared {@link TaskAssignedProjection}
 * — feed row + deferred assignment-reminder job, joining the dedup transaction
 * — while the other topics write the feed row directly. `dlqTopic`/`source`
 * are derived per topic exactly as the single-topic consumer derives them.
 */
@Injectable()
@KafkaConsumer(undefined, { groupId: GROUP_ID })
export class TaskActivityConsumer {
  constructor(
    @Inject(KafkaInboxConsumer) private readonly inbox: KafkaInboxConsumer,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TaskAssignedProjection)
    private readonly taskAssigned: TaskAssignedProjection,
  ) {}

  @KafkaHandler(TASK_CREATED_TOPIC)
  async onTaskCreated(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.project(TASK_CREATED_TOPIC, payload, headers, context, {
      validate: isTaskCreatedPayload,
      apply: (value) => {
        this.activity.record(taskCreatedActivity(value));
      },
    });
  }

  @KafkaHandler(TASK_ASSIGNED_TOPIC)
  async onTaskAssigned(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.project(TASK_ASSIGNED_TOPIC, payload, headers, context, {
      validate: isTaskAssignedPayload,
      // Joins the dedup transaction (synchronously, on better-sqlite3) and
      // enqueues the assignment-reminder job atomically with the feed row; the
      // `void` discards the Promise the @Transactional signature imposes.
      apply: (value) => {
        void this.taskAssigned.apply(value);
      },
    });
  }

  @KafkaHandler(TASK_COMPLETED_TOPIC)
  async onTaskCompleted(
    @KafkaMessage() payload: unknown,
    @KafkaHeaders() headers: Record<string, WireHeaderValue>,
    @KafkaCtx() context: KafkaContext,
  ): Promise<void> {
    await this.project(TASK_COMPLETED_TOPIC, payload, headers, context, {
      validate: isTaskCompletedPayload,
      apply: (value) => {
        this.activity.record(taskCompletedActivity(value));
      },
    });
  }

  // Shared engine call: dedup-scope + DLQ derived from the topic, the payload
  // narrowed by `validate` (a failure dead-letters), and `apply` — the topic's
  // synchronous projection write — run exactly once inside the dedup transaction.
  private async project<T>(
    topic: string,
    payload: unknown,
    headers: Record<string, WireHeaderValue>,
    context: KafkaContext,
    projection: {
      validate: (value: unknown) => value is T;
      apply: (value: T) => void;
    },
  ): Promise<void> {
    await this.inbox.consume<T>({
      source: `${topic}:${GROUP_ID}`,
      context,
      headers,
      payload,
      validate: projection.validate,
      sideEffect: projection.apply,
      dlqTopic: `${topic}.DLQ`,
    });
  }
}
