import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { RecoveringChannelModel } from 'amqplib';
import type { RabbitmqEnv } from '../../config/env';
import { TaskActivityProjections } from '../inbox/task-activity.projections';
import { InboxDeliveries } from './inbox-deliveries.service';
import { RabbitInbox } from './rabbit-inbox';
import { RABBITMQ_ENV } from './rabbitmq-connection.module';
import { type Subscription, subscribe } from './rabbit-subscription';
import {
  deadLetterExchange,
  RABBITMQ,
  TASK_ACTIVITY_QUEUE,
} from './rabbitmq.topology';

/**
 * RabbitMQ-profile consumer for the task lifecycle. All three topics arrive on
 * one queue; the routing key names the topic, and the consumer applies the same
 * {@link TaskActivityProjections} the Kafka profile does. The inbox's consumer
 * name is the queue, and the message id is unique across topics, so one name
 * covers all three.
 */
@Injectable()
export class TaskActivityRabbitConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TaskActivityRabbitConsumer.name);
  private subscription: Subscription | undefined;

  constructor(
    @Inject(RABBITMQ) private readonly rabbit: RecoveringChannelModel,
    @Inject(RABBITMQ_ENV) private readonly env: RabbitmqEnv,
    @Inject(RabbitInbox) private readonly inbox: RabbitInbox,
    @Inject(TaskActivityProjections)
    private readonly projections: TaskActivityProjections,
    @Inject(InboxDeliveries) private readonly deliveries: InboxDeliveries,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.subscription = await subscribe(
      this.rabbit,
      TASK_ACTIVITY_QUEUE,
      async (message, { channel, deadLetterChannel }) => {
        const topic = message.fields.routingKey;
        const projection = this.projections.byTopic.get(topic);
        if (!projection) {
          // Only a binding this consumer does not know can deliver this. Reject
          // it into the queue's dead-letter exchange rather than guess.
          this.logger.warn(`${TASK_ACTIVITY_QUEUE.name}: no projection for "${topic}"; dead-lettered`);
          channel.nack(message, false, false);
          return;
        }
        const result = await this.inbox.consume<unknown>({
          consumer: TASK_ACTIVITY_QUEUE.name,
          channel,
          message,
          validate: (payload): payload is unknown => projection.validate(payload),
          sideEffect: (payload, dedupKey) => projection.apply(payload, dedupKey),
          deadLetter: {
            channel: deadLetterChannel,
            exchange: deadLetterExchange(this.env.exchange),
            routingKey: TASK_ACTIVITY_QUEUE.name,
          },
        });
        this.deliveries.record({ queue: TASK_ACTIVITY_QUEUE.name, ...result });
      },
      this.logger,
    );
  }

  /** Runs before the connection closes, so its channels closing are not mistaken for a failure. */
  beforeApplicationShutdown(): void {
    this.subscription?.stop();
  }
}
