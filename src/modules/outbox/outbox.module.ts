import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FakeEmailTransport } from './fake-email-transport.service';
import { OutboxClaimer } from './outbox-claimer.service';
import { OutboxProducer } from './outbox-producer.service';
import { OutboxRegistry } from './outbox-registry.service';
import { UserInvitedHandler } from './user-invited.handler';

@Module({
  imports: [DatabaseModule],
  providers: [
    OutboxRegistry,
    OutboxProducer,
    OutboxClaimer,
    FakeEmailTransport,
    UserInvitedHandler,
  ],
  exports: [OutboxProducer, OutboxClaimer, OutboxRegistry, FakeEmailTransport],
})
export class OutboxModule {}
