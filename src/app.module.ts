import { type ModuleMetadata, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { KafkaModule, KafkaProducerService } from '@nest-native/kafka';
import { MessagingModule } from '@nest-native/messaging';
import { KafkaOutboxTransport } from '@nest-native/messaging/kafka';
import { SqliteInboxStore, SqliteOutboxStore } from '@nest-native/messaging/sqlite';
import { loadEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { UserInvitedInboxModule } from './modules/inbox/user-invited-inbox.module';
import { InProcessOutboxModule } from './modules/outbox/in-process-outbox.module';
import { InProcessOutboxTransport } from './modules/outbox/in-process-outbox-transport';
import { OutboxRegistry } from './modules/outbox/outbox-registry.service';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { UsersModule } from './modules/users/users.module';
import { AppTrpcModule } from './trpc/trpc.module';

// Reliable-messaging wiring, now built on `@nest-native/messaging`. Kafka is an
// opt-in profile: with KAFKA_BROKERS unset, the engine's claimer publishes
// through the app's in-process transport (registry → FakeEmailTransport) and the
// inbox dedup primitive is available for the hermetic test — byte-for-byte the
// app's pre-Kafka behaviour. With KAFKA_BROKERS set, the global KafkaModule comes
// online, the claimer publishes through the library's Kafka transport, and the
// UserInvitedConsumer subscribes. The drizzle client token is global, so the
// engine resolves the base Drizzle instance from it directly.
const kafkaEnv = loadEnv().kafka;
const drizzleInstanceToken = getDrizzleClientToken();

function messagingImports(): NonNullable<ModuleMetadata['imports']> {
  if (!kafkaEnv?.enabled) {
    return [
      InProcessOutboxModule,
      MessagingModule.forRootAsync({
        drizzleInstanceToken,
        outboxStore: new SqliteOutboxStore(),
        inboxStore: new SqliteInboxStore(),
        imports: [InProcessOutboxModule],
        inject: [OutboxRegistry],
        // `useTransport` is typed `(...args: unknown[]) => ...` (unlike Nest's
        // `useFactory: (...args: any[]) => T`), so a factory with typed params is
        // not assignable under strictFunctionTypes — narrow from unknown here.
        useTransport: (registry) =>
          new InProcessOutboxTransport(registry as OutboxRegistry),
      }),
    ];
  }
  return [
    KafkaModule.forRootAsync({
      isGlobal: true,
      useFactory: () => ({
        clientId: kafkaEnv.clientId,
        client: { brokers: kafkaEnv.brokers },
        // Idempotent producer + acks=all: the outbox already gives us
        // at-least-once; idempotence keeps a producer retry from duplicating a
        // partition write, and acks=all waits for the full ISR before the
        // claimer marks the row completed.
        producer: { 'enable.idempotence': true, acks: 'all' },
      }),
    }),
    UserInvitedInboxModule,
    MessagingModule.forRootAsync({
      drizzleInstanceToken,
      outboxStore: new SqliteOutboxStore(),
      inboxStore: new SqliteInboxStore(),
      inject: [KafkaProducerService],
      // See the narrow-from-unknown note above: `useTransport` uses `unknown[]`.
      useTransport: (producer) =>
        new KafkaOutboxTransport(
          producer as KafkaProducerService,
          kafkaEnv.topicPrefix,
        ),
    }),
  ];
}

@Module({
  imports: [
    DatabaseModule,
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
            drizzleInstanceToken: getDrizzleClientToken(),
          }),
          enableTransactionProxy: true,
        }),
      ],
    }),
    AuthModule,
    RequestContextModule,
    AuditLogModule,
    ...messagingImports(),
    OrganizationsModule,
    UsersModule,
    ProjectsModule,
    OnboardingModule,
    AppTrpcModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
