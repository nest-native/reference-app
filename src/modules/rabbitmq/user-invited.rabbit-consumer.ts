import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { RecoveringChannelModel } from 'amqplib';
import type { RabbitmqEnv } from '../../config/env';
import { AuditLogService } from '../audit-log/audit-log.service';
import { userInvitedDelivered } from '../inbox/user-invited.delivery';
import {
  isUserInvitedPayload,
  type UserInvitedPayload,
} from '../outbox/outbox.constants';
import { InboxDeliveries } from './inbox-deliveries.service';
import { RabbitInbox } from './rabbit-inbox';
import { RABBITMQ_ENV } from './rabbitmq-connection.module';
import { type Subscription, subscribe } from './rabbit-subscription';
import {
  deadLetterExchange,
  RABBITMQ,
  USER_INVITED_QUEUE,
} from './rabbitmq.topology';

/**
 * RabbitMQ-profile consumer for `user.invited` — the counterpart of the Kafka
 * profile's {@link UserInvitedConsumer}, writing the same audit row through the
 * same {@link userInvitedDelivered}. The {@link RabbitInbox} engine dedups by
 * the message id the outbox transport stamped on the message, records it in the
 * official inbox in the transaction that runs the side effect, and settles the
 * delivery itself: ack when processed or a duplicate, dead-letter (with the
 * reason in `x-error`) when the payload can never be processed, requeue when
 * anything else failed.
 */
@Injectable()
export class UserInvitedRabbitConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(UserInvitedRabbitConsumer.name);
  private subscription: Subscription | undefined;

  constructor(
    @Inject(RABBITMQ) private readonly rabbit: RecoveringChannelModel,
    @Inject(RABBITMQ_ENV) private readonly env: RabbitmqEnv,
    @Inject(RabbitInbox) private readonly inbox: RabbitInbox,
    @Inject(AuditLogService) private readonly audit: AuditLogService,
    @Inject(InboxDeliveries) private readonly deliveries: InboxDeliveries,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.subscription = await subscribe(
      this.rabbit,
      USER_INVITED_QUEUE,
      async (message, { channel, deadLetterChannel }) => {
        const result = await this.inbox.consume<UserInvitedPayload>({
          consumer: USER_INVITED_QUEUE.name,
          channel,
          message,
          validate: isUserInvitedPayload,
          // Synchronous, DB-only (a better-sqlite3 transaction's rule): a throw
          // rolls the inbox record back with it, and the delivery is requeued.
          sideEffect: (invite) => {
            this.audit.record(userInvitedDelivered(invite));
          },
          deadLetter: {
            channel: deadLetterChannel,
            exchange: deadLetterExchange(this.env.exchange),
            routingKey: USER_INVITED_QUEUE.name,
          },
        });
        this.deliveries.record({ queue: USER_INVITED_QUEUE.name, ...result });
      },
      this.logger,
    );
  }

  /** Runs before the connection closes, so its channels closing are not mistaken for a failure. */
  beforeApplicationShutdown(): void {
    this.subscription?.stop();
  }
}
