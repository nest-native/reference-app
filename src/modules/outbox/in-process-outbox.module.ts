import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { TaskActivityProjections } from '../inbox/task-activity.projections';
import { ActivityHandler } from './activity.handler';
import { FakeEmailTransport } from './fake-email-transport.service';
import { UserInvitedHandler } from './user-invited.handler';

/**
 * The in-process consumers of the default profile, used when neither broker
 * is configured: `@OnOutboxMessage()` handlers, which the official outbox's
 * built-in `local` transport runs for every message the relay delivers.
 * {@link UserInvitedHandler} routes `user.invited` to {@link
 * FakeEmailTransport}, and {@link ActivityHandler} projects the task lifecycle
 * into the activity feed. Each handler keeps its own inbox, under its consumer
 * name.
 *
 * Imported in the default profile only: the outbox discovers handlers across
 * the whole app, and handlers next to a broker transport would make it demand
 * a `route` choosing between the two. {@link FakeEmailTransport} is exported so
 * integration tests can inspect what was "sent".
 */
@Module({
  imports: [ActivityModule],
  providers: [
    FakeEmailTransport,
    TaskActivityProjections,
    UserInvitedHandler,
    ActivityHandler,
  ],
  exports: [FakeEmailTransport],
})
export class InProcessOutboxModule {}
