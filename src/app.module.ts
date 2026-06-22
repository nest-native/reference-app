import { type ModuleMetadata, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { KafkaModule, KafkaProducerService } from '@nest-native/kafka';
import { loadEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { KafkaOutboxTransport } from './modules/outbox/kafka-outbox-transport';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { UsersModule } from './modules/users/users.module';
import { AppTrpcModule } from './trpc/trpc.module';

// Reliable-messaging wiring. Kafka is an opt-in profile: with KAFKA_BROKERS
// unset, the messaging imports are the bare OutboxModule + InboxModule and the
// app behaves byte-for-byte as it did before — in-process outbox dispatch, and
// the inbox dedup primitive available for the hermetic test. With KAFKA_BROKERS
// set, the global KafkaModule comes online and the outbox/inbox switch to their
// Kafka-backed forms (producer publishes to Kafka, consumers subscribe).
const kafkaEnv = loadEnv().kafka;

function messagingImports(): NonNullable<ModuleMetadata['imports']> {
  if (!kafkaEnv?.enabled) {
    return [OutboxModule, InboxModule];
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
    OutboxModule.forRootAsync({
      inject: [KafkaProducerService],
      useFactory: (producer: KafkaProducerService) =>
        new KafkaOutboxTransport(producer, kafkaEnv.topicPrefix),
    }),
    InboxModule.forRootAsync(),
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
