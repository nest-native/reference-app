import { Module } from '@nestjs/common';
import { KafkaInboxConsumer } from '@nest-native/messaging/kafka';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { UserInvitedConsumer } from './user-invited.consumer';

/**
 * The Kafka-profile inbox wiring. Provides the library's {@link KafkaInboxConsumer}
 * engine and the app's {@link UserInvitedConsumer} shell. The transport's
 * explorer discovers `@KafkaConsumer` classes across every module's providers,
 * so providing the shell here is all the registration it needs —
 * `KafkaModule.forFeature` is only for handlers not provided anywhere else,
 * and listing the shell there too would create a second copy inside the
 * feature module, where neither {@link KafkaInboxConsumer} nor
 * `AuditLogService` is visible.
 *
 * The engine resolves `InboxService` from the global `MessagingModule` (configured
 * with the SQLite inbox store) and `KafkaProducerService` from the global
 * `KafkaModule`; this module only supplies `AuditLogService` (for the delivery
 * side effect) via {@link AuditLogModule}.
 */
@Module({
  imports: [AuditLogModule],
  providers: [KafkaInboxConsumer, UserInvitedConsumer],
})
export class UserInvitedInboxModule {}
