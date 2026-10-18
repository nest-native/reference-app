import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { KafkaInbox } from './kafka-inbox';
import { TaskActivityConsumer } from './task-activity.consumer';
import { TaskActivityProjections } from './task-activity.projections';

/**
 * The Kafka-profile wiring for the activity feed — the read-model twin of {@link
 * UserInvitedInboxModule}. Provides the app's {@link KafkaInbox} engine and its
 * {@link TaskActivityConsumer} shell; the transport's
 * explorer discovers `@KafkaConsumer` providers across modules, so no
 * `KafkaModule.forFeature` registration is needed (see UserInvitedInboxModule
 * for why a duplicate forFeature copy would not even boot). {@link
 * ActivityModule} supplies {@link ActivityService} (the exactly-once feed
 * write); `OutboxInbox` and `KafkaProducerService` are resolved from the
 * global OutboxModule / KafkaModule.
 */
@Module({
  imports: [ActivityModule],
  providers: [KafkaInbox, TaskActivityProjections, TaskActivityConsumer],
})
export class TaskActivityInboxModule {}
