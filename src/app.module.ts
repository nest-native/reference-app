import { type ModuleMetadata, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { getDrizzleToken } from '@nestjs/drizzle';
import { JobsModule } from '@nest-native/jobs';
import { SqliteJobStore, SqliteScheduleStore } from '@nest-native/jobs/sqlite';
import { KafkaModule, KafkaProducerService } from '@nest-native/kafka';
import { OutboxModule, type OutboxModuleOptions } from '@nestjs/outbox';
import type { RecoveringChannelModel } from 'amqplib';
import { loadEnv, type RabbitmqEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { ActivityModule } from './modules/activity/activity.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { EventsCatalogModule } from './modules/events-catalog/events-catalog.module';
import { TaskActivityInboxModule } from './modules/inbox/task-activity-inbox.module';
import { TASK_SUMMARY_REPLY_TOPIC } from './modules/task-summary/task-summary.contract';
import { TaskSummaryModule } from './modules/task-summary/task-summary.module';
import { UserInvitedInboxModule } from './modules/inbox/user-invited-inbox.module';
import { InProcessOutboxModule } from './modules/outbox/in-process-outbox.module';
import { KafkaOutboxTransport } from './modules/outbox/kafka-outbox.transport';
import { sqliteOutboxStoreProvider } from './modules/outbox/sqlite-outbox.store';
import { RabbitmqConnectionModule } from './modules/rabbitmq/rabbitmq-connection.module';
import { RabbitmqInboxModule } from './modules/rabbitmq/rabbitmq-inbox.module';
import { RabbitOutboxTransport } from './modules/rabbitmq/rabbit-outbox.transport';
import { RABBITMQ } from './modules/rabbitmq/rabbitmq.topology';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { UsersModule } from './modules/users/users.module';
import { AppTrpcModule } from './trpc/trpc.module';
import { AppCacheModule } from './cache/cache.setup';

// Reliable messaging runs on the official `@nestjs/outbox`, in three profiles
// that share the producers, the store and the read-sides. With no broker
// configured, the outbox's built-in `local` transport runs the in-process
// `@OnOutboxMessage()` handlers (FakeEmailTransport, the activity feed). With
// KAFKA_BROKERS set, the global KafkaModule comes online, the outbox publishes
// through the app's KafkaOutboxTransport, and the Kafka consumers record their
// deliveries in the outbox's inbox. RABBITMQ_URL is the third profile, the same
// shape over the app's RabbitOutboxTransport and RabbitMQ consumers. The two
// broker profiles are mutually exclusive (loadEnv refuses both). Every profile
// keeps the messages and the inboxes in the app's SQLite database, through
// SqliteOutboxStore, registered once below.
const {
  kafka: kafkaEnv,
  rabbitmq: rabbitmqEnv,
  outbox: outboxEnv,
} = loadEnv();
const drizzleInstanceToken = getDrizzleToken();

// The relay is off in every process this module boots: scripts/start-worker.ts
// starts it (one worker drains the outbox and the jobs queue), and the tests
// flush it with runOnce(). publishTimeout bounds a publish, a broker's confirm
// included, and has to stay below the lease (OUTBOX_STUCK_TIMEOUT_MS). The
// retry budget is the one the app's events had before this module (10
// attempts, 1 s doubling to 1 min); the module's default (20 attempts, up to
// 5 min apart) keeps retrying for 30 to 60 minutes.
const outboxOptions = {
  relay: {
    enabled: false,
    pollInterval: outboxEnv.pollIntervalMs,
    batchSize: outboxEnv.batchSize,
    lease: outboxEnv.stuckTimeoutMs,
    publishTimeout: '10s',
  },
  retry: { attempts: 10, backoff: { delay: '1s', maxDelay: '1m' } },
} satisfies OutboxModuleOptions;

function messagingImports(): NonNullable<ModuleMetadata['imports']> {
  if (rabbitmqEnv?.enabled) {
    return rabbitmqMessagingImports(rabbitmqEnv);
  }
  if (!kafkaEnv?.enabled) {
    return [InProcessOutboxModule, OutboxModule.forRoot(outboxOptions)];
  }
  return [
    KafkaModule.forRootAsync({
      isGlobal: true,
      useFactory: () => ({
        clientId: kafkaEnv.clientId,
        client: { brokers: kafkaEnv.brokers },
        // Idempotent producer + acks=all: the outbox already gives us
        // at-least-once; idempotence keeps a producer retry from duplicating a
        // partition write, and acks=all (-1) waits for the full ISR before the
        // relay counts the message published. These are the kafkajs-style keys.
        // Since @nest-native/kafka 0.4.x raw librdkafka keys work here too —
        // the library routes dotted names (and the undotted ones the client
        // declares, like `debug`) to where librdkafka reads them — so the two
        // families can be mixed in this one object.
        producer: { idempotent: true, acks: -1 },
        // Opt into request-reply for the one exchange in this app that is a
        // question rather than an event (see TaskSummaryConsumer). Without this
        // block no reply consumer is created and the feature costs nothing.
        requestReply: {
          replyTopic: `${kafkaEnv.topicPrefix}${TASK_SUMMARY_REPLY_TOPIC}`,
        },
      }),
    }),
    UserInvitedInboxModule,
    TaskActivityInboxModule,
    TaskSummaryModule,
    OutboxModule.forRootAsync({
      inject: [KafkaProducerService],
      useFactory: (producer: KafkaProducerService) => ({
        ...outboxOptions,
        transports: {
          kafka: new KafkaOutboxTransport(producer, kafkaEnv.topicPrefix),
        },
      }),
    }),
  ];
}

// The RabbitMQ profile: every outbox message is published to one topic exchange
// with its topic as the routing key, on a confirm channel — a message counts as
// published only once the broker acked it and did not return it. The consumers
// share the app's connection and run the same read-sides as the Kafka profile.
function rabbitmqMessagingImports(
  env: RabbitmqEnv,
): NonNullable<ModuleMetadata['imports']> {
  return [
    RabbitmqConnectionModule.forRoot(env),
    RabbitmqInboxModule,
    OutboxModule.forRootAsync({
      inject: [RABBITMQ],
      useFactory: (connection: RecoveringChannelModel) => ({
        ...outboxOptions,
        transports: {
          rabbitmq: new RabbitOutboxTransport({
            connection,
            exchange: env.exchange,
          }),
        },
      }),
    }),
  ];
}

@Module({
  imports: [
    DatabaseModule,
    AppCacheModule,
    ClsModule.forRoot({
      global: true,
      plugins: [
        new ClsPluginTransactional({
          imports: [DatabaseModule],
          // better-sqlite3 is synchronous; the official adapter (>=1.3.0)
          // auto-detects this (`transactionMode: 'auto'`) and runs the
          // transaction callback in sync mode, so the @Transactional()
          // methods in this app stay synchronous.
          adapter: new TransactionalAdapterDrizzleOrm({
            drizzleInstanceToken: getDrizzleToken(),
          }),
          enableTransactionProxy: true,
        }),
      ],
    }),
    AuthModule,
    RequestContextModule,
    AuditLogModule,
    // Deferred work runs on the same wiring under every messaging profile: the
    // jobs engine resolves the global drizzle database token directly, enqueue
    // joins whatever CLS transaction is open, and the claimer runs in the
    // background worker (scripts/start-worker.ts).
    JobsModule.forRoot({
      drizzleInstanceToken,
      store: new SqliteJobStore(),
      // Opt in to DB-stored cron schedules; without this the claimer never
      // touches the job_schedules table. See RemindersModule for the sweep.
      scheduleStore: new SqliteScheduleStore(),
    }),
    RemindersModule,
    ...messagingImports(),
    OrganizationsModule,
    UsersModule,
    ProjectsModule,
    TasksModule,
    ActivityModule,
    AssistantModule,
    OnboardingModule,
    AppTrpcModule,
    EventsCatalogModule,
  ],
  controllers: [HealthController],
  // The outbox's store, registered with it once, in the module that imports
  // OutboxModule: every profile keeps its messages and inboxes in SQLite.
  providers: [sqliteOutboxStoreProvider],
})
export class AppModule {}
