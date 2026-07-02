import { Module } from '@nestjs/common';
import { OutboxRegistry } from '@nest-native/messaging/in-process';
import { ActivityModule } from '../activity/activity.module';
import { ActivityHandler } from './activity.handler';
import { FakeEmailTransport } from './fake-email-transport.service';
import { UserInvitedHandler } from './user-invited.handler';

/**
 * The in-process dispatch chain used when the Kafka profile is OFF. It provides
 * the library's {@link OutboxRegistry} (from `@nest-native/messaging/in-process`)
 * that `InProcessOutboxTransport` dispatches through: {@link UserInvitedHandler}
 * registers itself into the registry on init, and routes `user.invited` events
 * to {@link FakeEmailTransport}.
 *
 * `MessagingModule.forRootAsync` imports this module and injects {@link
 * OutboxRegistry} into its transport factory (`new InProcessOutboxTransport(registry)`),
 * so the library's claimer publishes through this in-process chain — the same
 * behaviour the app had before the engine was extracted. {@link FakeEmailTransport}
 * is exported so integration tests can inspect what was "sent".
 */
@Module({
  imports: [ActivityModule],
  providers: [
    OutboxRegistry,
    FakeEmailTransport,
    UserInvitedHandler,
    ActivityHandler,
  ],
  exports: [OutboxRegistry, FakeEmailTransport],
})
export class InProcessOutboxModule {}
