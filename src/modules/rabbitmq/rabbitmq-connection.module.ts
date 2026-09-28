import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { connect, type RecoveringChannelModel } from 'amqplib';
import type { RabbitmqEnv } from '../../config/env';
import { declareTopology, RABBITMQ } from './rabbitmq.topology';

const RABBITMQ_ENV = Symbol.for('reference-app:rabbitmq-env');
/** The name the app's connection carries on the broker (see the management UI). */
const CONNECTION_NAME = 'reference-app';

/** Declares the topology in `onModuleInit`, a phase that completes before any consumer subscribes in `onApplicationBootstrap`. */
@Injectable()
class RabbitmqTopology implements OnModuleInit {
  constructor(
    @Inject(RABBITMQ) private readonly connection: RecoveringChannelModel,
    @Inject(RABBITMQ_ENV) private readonly env: RabbitmqEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    const channel = await this.connection.createChannel();
    try {
      await declareTopology(channel, this.env.exchange);
    } finally {
      await channel.close();
    }
  }
}

/**
 * Closes the connection on shutdown. It runs in `onApplicationShutdown`, after
 * the outbox worker has stopped (the worker process aborts its loops before it
 * closes the app), and every channel on the connection closes with it — an
 * unacked delivery goes back to its queue for the next consumer.
 */
@Injectable()
class RabbitmqConnectionCloser implements OnApplicationShutdown {
  private readonly logger = new Logger('RabbitMQ');

  constructor(@Inject(RABBITMQ) private readonly connection: RecoveringChannelModel) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close().catch((error: unknown) => {
      this.logger.warn(`closing the connection failed: ${String(error)}`);
    });
  }
}

/**
 * The app's RabbitMQ connection, shared by the outbox transport and the inbox
 * consumers — they only open channels on it. `recovery: true` is amqplib 2's
 * built-in reconnection: the connection comes back after a broker restart, but
 * its channels do not, which is why the transport reopens its channel lazily
 * and every consumer subscribes again when its channel closes.
 */
@Module({})
export class RabbitmqConnectionModule {
  static forRoot(env: RabbitmqEnv): DynamicModule {
    return {
      module: RabbitmqConnectionModule,
      global: true,
      providers: [
        { provide: RABBITMQ_ENV, useValue: env },
        {
          provide: RABBITMQ,
          useFactory: async () => {
            const connection = await connect(env.url, {
              recovery: true,
              clientProperties: { connection_name: CONNECTION_NAME },
            });
            // amqplib re-emits connection errors, and an EventEmitter with no
            // 'error' listener throws them: a lost socket would crash the
            // process before recovery could reconnect it.
            const logger = new Logger('RabbitMQ');
            connection.on('error', (error: Error) => logger.warn(error.message));
            return connection;
          },
        },
        RabbitmqTopology,
        RabbitmqConnectionCloser,
      ],
      exports: [RABBITMQ, RABBITMQ_ENV],
    };
  }
}

export { RABBITMQ_ENV };
