import { Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { getDrizzleClientToken } from 'nest-drizzle-native';
import { AuthModule } from './auth/auth.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { UsersModule } from './modules/users/users.module';
import { AppTrpcModule } from './trpc/trpc.module';

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
    OutboxModule,
    OrganizationsModule,
    UsersModule,
    ProjectsModule,
    OnboardingModule,
    AppTrpcModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
