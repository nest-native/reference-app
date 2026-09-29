import { Module } from '@nestjs/common';
import { RabbitInboxConsumer } from '@nest-native/messaging/rabbitmq';
import { ActivityModule } from '../activity/activity.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TaskActivityProjections } from '../inbox/task-activity.projections';
import { InboxDeliveries } from './inbox-deliveries.service';
import { TaskActivityRabbitConsumer } from './task-activity.rabbit-consumer';
import { UserInvitedRabbitConsumer } from './user-invited.rabbit-consumer';

/**
 * The RabbitMQ profile's consumers: the same two read-sides the Kafka profile
 * runs (the invite audit and the task activity feed), subscribed to the queues
 * {@link declareTopology} binds. Registered only when RABBITMQ_URL is set.
 */
@Module({
  imports: [AuditLogModule, ActivityModule],
  providers: [
    RabbitInboxConsumer,
    TaskActivityProjections,
    InboxDeliveries,
    UserInvitedRabbitConsumer,
    TaskActivityRabbitConsumer,
  ],
  exports: [InboxDeliveries],
})
export class RabbitmqInboxModule {}
