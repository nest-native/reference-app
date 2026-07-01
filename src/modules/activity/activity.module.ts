import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { DatabaseModule } from '../../database/database.module';
import { ActivityRouter } from './activity.router';
import { ActivityService } from './activity.service';

/**
 * The activity feed read-model. {@link ActivityService} is exported so the
 * messaging profiles can feed it: the in-process {@link
 * import('../outbox/activity.handler').ActivityHandler} (default) and the Kafka
 * {@link import('../inbox/task-activity.consumer').TaskActivityConsumer} (gated)
 * both import this module and call `record`. DatabaseModule provides the
 * transactional Drizzle instance the service writes/reads through.
 */
@Module({
  imports: [DatabaseModule, AuthModule, RequestContextModule],
  providers: [ActivityService, ActivityRouter],
  exports: [ActivityService],
})
export class ActivityModule {}
