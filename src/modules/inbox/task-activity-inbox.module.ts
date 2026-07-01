import { Module } from '@nestjs/common';
import { KafkaModule } from '@nest-native/kafka';
import { KafkaInboxConsumer } from '@nest-native/messaging/kafka';
import { ActivityModule } from '../activity/activity.module';
import { TaskActivityConsumer } from './task-activity.consumer';

/**
 * The Kafka-profile wiring for the activity feed — the read-model twin of {@link
 * UserInvitedInboxModule}. Provides the library's {@link KafkaInboxConsumer}
 * engine and the app's {@link TaskActivityConsumer} shell, and registers the
 * shell with {@link KafkaModule.forFeature} so the transport subscribes its
 * per-topic handlers. {@link ActivityModule} supplies {@link ActivityService}
 * (the exactly-once feed write); `InboxService` and `KafkaProducerService` are
 * resolved from the global MessagingModule / KafkaModule.
 */
@Module({
  imports: [ActivityModule, KafkaModule.forFeature([TaskActivityConsumer])],
  providers: [KafkaInboxConsumer, TaskActivityConsumer],
})
export class TaskActivityInboxModule {}
