import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { RequestContextModule } from './context/request-context.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AppTrpcModule } from './trpc/trpc.module';

@Module({
  imports: [DatabaseModule, AuthModule, RequestContextModule, AppTrpcModule],
  controllers: [HealthController],
})
export class AppModule {}
