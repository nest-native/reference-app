import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { KafkaInbox } from './kafka-inbox';
import { UserInvitedConsumer } from './user-invited.consumer';

/**
 * The Kafka-profile inbox wiring. Provides the app's {@link KafkaInbox} engine
 * and its {@link UserInvitedConsumer} shell. The transport's
 * explorer discovers `@KafkaConsumer` classes across every module's providers,
 * so providing the shell here is all the registration it needs —
 * `KafkaModule.forFeature` is only for handlers not provided anywhere else,
 * and listing the shell there too would create a second copy inside the
 * feature module, where neither {@link KafkaInbox} nor `AuditLogService` is
 * visible.
 *
 * The engine resolves `OutboxInbox` from the global `OutboxModule` (on the
 * app's SQLite store) and `KafkaProducerService` from the global
 * `KafkaModule`; this module only supplies `AuditLogService` (for the delivery
 * side effect) via {@link AuditLogModule}.
 */
@Module({
  imports: [AuditLogModule],
  providers: [KafkaInbox, UserInvitedConsumer],
})
export class UserInvitedInboxModule {}
