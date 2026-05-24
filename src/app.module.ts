import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AppTrpcModule } from './trpc/trpc.module';

@Module({
  imports: [DatabaseModule, AppTrpcModule],
  controllers: [HealthController],
})
export class AppModule {}
