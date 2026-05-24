import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { UsersModule } from './modules/users/users.module';
import { AppTrpcModule } from './trpc/trpc.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    RequestContextModule,
    OrganizationsModule,
    UsersModule,
    ProjectsModule,
    AppTrpcModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
