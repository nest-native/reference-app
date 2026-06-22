import {
  type DynamicModule,
  type ModuleMetadata,
  Module,
} from '@nestjs/common';
import { KafkaModule } from '@nest-native/kafka';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { InboxService } from './inbox.service';
import { UserInvitedConsumer } from './user-invited.consumer';

/**
 * Options for {@link InboxModule.forRootAsync}. The inbox itself needs no
 * configuration; the async form exists so the Kafka profile can supply the
 * imports (e.g. the global {@link KafkaModule}) the consumers resolve against.
 */
export type InboxModuleAsyncOptions = Pick<ModuleMetadata, 'imports'>;

/**
 * Inbox module.
 *
 * Bare (`imports: [InboxModule]`) provides ONLY {@link InboxService} — the
 * synchronous, broker-free dedup primitive. That keeps the hermetic dedup test
 * (and any in-process consumer of the primitive) runnable with no Kafka, which
 * is exactly today's Kafka-off behaviour.
 *
 * The Kafka profile imports {@link InboxModule.forRootAsync} instead, which adds
 * the {@link UserInvitedConsumer} and registers it with the Kafka transport via
 * {@link KafkaModule.forFeature} so it subscribes and consumes.
 */
@Module({
  imports: [DatabaseModule],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {
  /**
   * Wire the inbox with its Kafka consumers. Registers {@link UserInvitedConsumer}
   * as a provider and with {@link KafkaModule.forFeature} so the transport
   * discovers and subscribes it. Requires the global {@link KafkaModule} (for the
   * producer service the DLQ path uses) to be imported by the application.
   */
  static forRootAsync(options: InboxModuleAsyncOptions = {}): DynamicModule {
    return {
      module: InboxModule,
      imports: [
        DatabaseModule,
        AuditLogModule,
        KafkaModule.forFeature([UserInvitedConsumer]),
        ...(options.imports ?? []),
      ],
      providers: [InboxService, UserInvitedConsumer],
      exports: [InboxService],
    };
  }
}
