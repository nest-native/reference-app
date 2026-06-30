import { Module } from '@nestjs/common';
import { FakeEmailTransport } from './fake-email-transport.service';
import { OutboxRegistry } from './outbox-registry.service';
import { UserInvitedHandler } from './user-invited.handler';

/**
 * The in-process dispatch chain used when the Kafka profile is OFF. It owns the
 * app-specific handler registry that {@link InProcessOutboxTransport} dispatches
 * through: {@link UserInvitedHandler} registers itself into {@link OutboxRegistry}
 * on init, and routes `user.invited` events to {@link FakeEmailTransport}.
 *
 * `MessagingModule.forRootAsync` imports this module and injects {@link
 * OutboxRegistry} into its transport factory (`new InProcessOutboxTransport(registry)`),
 * so the library's claimer publishes through this in-process chain — the same
 * behaviour the app had before the engine was extracted. {@link FakeEmailTransport}
 * is exported so integration tests can inspect what was "sent".
 */
@Module({
  providers: [OutboxRegistry, FakeEmailTransport, UserInvitedHandler],
  exports: [OutboxRegistry, FakeEmailTransport],
})
export class InProcessOutboxModule {}
