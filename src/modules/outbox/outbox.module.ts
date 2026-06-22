import {
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  Module,
  type Provider,
} from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FakeEmailTransport } from './fake-email-transport.service';
import { InProcessOutboxTransport } from './in-process-outbox-transport';
import { OutboxClaimer } from './outbox-claimer.service';
import { OutboxProducer } from './outbox-producer.service';
import { OutboxRegistry } from './outbox-registry.service';
import { OUTBOX_TRANSPORT } from './outbox-transport';
import { UserInvitedHandler } from './user-invited.handler';

/**
 * Options for {@link OutboxModule.forRoot}: supply the {@link Provider} that
 * binds the {@link OUTBOX_TRANSPORT} token (e.g. the Kafka transport).
 */
export interface OutboxModuleOptions {
  transport: Provider;
}

/**
 * Options for {@link OutboxModule.forRootAsync}: resolve the
 * {@link OUTBOX_TRANSPORT} instance through a factory so it can inject
 * dependencies (e.g. the Kafka producer service) that only exist when the Kafka
 * profile is active.
 */
export interface OutboxModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  inject?: FactoryProvider['inject'];
  useFactory: FactoryProvider['useFactory'];
}

// The publishing engine — producer + claimer. Shared by the bare module and
// both dynamic forms; only the OUTBOX_TRANSPORT binding differs between them.
const ENGINE_PROVIDERS: Provider[] = [OutboxProducer, OutboxClaimer];

// The in-process handler chain the default transport dispatches through. Only
// the bare module wires these; the Kafka profile publishes to a broker instead
// and has no use for the in-memory registry/email transport.
const IN_PROCESS_PROVIDERS: Provider[] = [
  OutboxRegistry,
  FakeEmailTransport,
  UserInvitedHandler,
  { provide: OUTBOX_TRANSPORT, useClass: InProcessOutboxTransport },
];

const BARE_EXPORTS = [
  OutboxProducer,
  OutboxClaimer,
  OUTBOX_TRANSPORT,
  OutboxRegistry,
  FakeEmailTransport,
];

/**
 * Outbox module.
 *
 * Bare (`imports: [OutboxModule]`) keeps today's behaviour exactly: the
 * transactional producer, the claimer, and the in-process transport that
 * dispatches to registered handlers (the {@link UserInvitedHandler} →
 * {@link FakeEmailTransport} chain). No Kafka, no config — every existing test
 * and `app.module.ts` import works untouched.
 *
 * The Kafka profile imports {@link OutboxModule.forRootAsync} instead and binds
 * {@link OUTBOX_TRANSPORT} to a Kafka transport, so the same producer/claimer
 * publish to a broker.
 */
@Module({
  imports: [DatabaseModule],
  providers: [...ENGINE_PROVIDERS, ...IN_PROCESS_PROVIDERS],
  exports: BARE_EXPORTS,
})
export class OutboxModule {
  /**
   * Wire the outbox with a caller-supplied transport provider. The provider
   * must bind the {@link OUTBOX_TRANSPORT} token.
   */
  static forRoot(options: OutboxModuleOptions): DynamicModule {
    return {
      module: OutboxModule,
      imports: [DatabaseModule],
      providers: [...ENGINE_PROVIDERS, options.transport],
      exports: [...ENGINE_PROVIDERS, OUTBOX_TRANSPORT],
    };
  }

  /**
   * Wire the outbox with a transport resolved asynchronously through a factory,
   * so the transport can inject dependencies (e.g. the Kafka producer service).
   */
  static forRootAsync(options: OutboxModuleAsyncOptions): DynamicModule {
    const transport: Provider = {
      provide: OUTBOX_TRANSPORT,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: OutboxModule,
      imports: [DatabaseModule, ...(options.imports ?? [])],
      providers: [...ENGINE_PROVIDERS, transport],
      exports: [...ENGINE_PROVIDERS, OUTBOX_TRANSPORT],
    };
  }
}
