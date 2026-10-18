import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { DatabaseModule } from '../../database/database.module';
import { ActivityRouter } from './activity.router';
import { ActivityService } from './activity.service';
import { TaskAssignedProjection } from './task-assigned-projection.service';

/**
 * The activity feed read-model. {@link ActivityService} is exported so the
 * messaging profiles can feed it: the in-process {@link
 * import('../outbox/activity.handler').ActivityHandler} (default) and the Kafka
 * and RabbitMQ consumers (gated) all import this module and reach `record`
 * through the shared `TaskActivityProjections`. For `task.assigned` that goes
 * through {@link TaskAssignedProjection}, which also schedules the deferred
 * assignment reminder in the same transaction. DatabaseModule provides the
 * transactional Drizzle instance the services write/read through; the global
 * JobsModule provides the JobsService the projection enqueues with.
 */
@Module({
  imports: [DatabaseModule, AuthModule, RequestContextModule],
  providers: [ActivityService, TaskAssignedProjection, ActivityRouter],
  exports: [ActivityService, TaskAssignedProjection],
})
export class ActivityModule {}
