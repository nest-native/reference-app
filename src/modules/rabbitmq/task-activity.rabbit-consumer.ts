import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { RabbitInboxConsumer } from '@nest-native/messaging/rabbitmq';
import type { RecoveringChannelModel } from 'amqplib';
import type { RabbitmqEnv } from '../../config/env';
import { TaskActivityProjections } from '../inbox/task-activity.projections';
import { InboxDeliveries } from './inbox-deliveries.service';
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
 * {@link TaskActivityProjections} the Kafka profile does. The inbox's dedup
 * `source` is the queue, and the event id is unique across topics, so one
 * source covers all three.
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
    @Inject(RabbitInboxConsumer) private readonly inbox: RabbitInboxConsumer,
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
          source: TASK_ACTIVITY_QUEUE.name,
          channel,
          message,
          validate: (payload): payload is unknown => projection.validate(payload),
          sideEffect: (payload) => projection.apply(payload),
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
