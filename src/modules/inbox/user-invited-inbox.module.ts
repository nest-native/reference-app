import { Module } from '@nestjs/common';
import { KafkaModule } from '@nest-native/kafka';
import { KafkaInboxConsumer } from '@nest-native/messaging/kafka';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { UserInvitedConsumer } from './user-invited.consumer';

/**
 * The Kafka-profile inbox wiring. Provides the library's {@link KafkaInboxConsumer}
 * engine and the app's {@link UserInvitedConsumer} shell, and registers the shell
 * with {@link KafkaModule.forFeature} so the transport subscribes it.
 *
 * The engine resolves `InboxService` from the global `MessagingModule` (configured
 * with the SQLite inbox store) and `KafkaProducerService` from the global
 * `KafkaModule`; this module only supplies `AuditLogService` (for the delivery
 * side effect) via {@link AuditLogModule}.
 */
@Module({
  imports: [AuditLogModule, KafkaModule.forFeature([UserInvitedConsumer])],
  providers: [KafkaInboxConsumer, UserInvitedConsumer],
})
export class UserInvitedInboxModule {}
