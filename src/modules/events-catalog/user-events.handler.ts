import { Controller } from '@nestjs/common';
import {
  AsyncApiChannel,
  AsyncApiHeaders,
  AsyncApiMessage,
  AsyncApiPub,
  AsyncApiServer,
} from '@nest-native/asyncapi';
import {
  eventHeadersSource,
  KAFKA_SERVER_HOST,
  KAFKA_SERVER_NAME,
  kafkaServerOptions,
  userInvitedMessageSource,
} from './event-schemas';

/**
 * Documentation-only handler for the `user.invited` domain event.
 *
 * It carries no runtime behaviour — the outbox actually publishes the event
 * (see `src/modules/outbox`). The AsyncAPI decorators below describe the Kafka
 * `user.invited` topic so the generator ({@link getAsyncApiDocument}) can emit a
 * channel + `send` operation + message for it. The channel address is the exact
 * Kafka topic external consumers subscribe to.
 */
@AsyncApiServer(KAFKA_SERVER_NAME, KAFKA_SERVER_HOST, 'kafka', kafkaServerOptions)
@AsyncApiChannel('user.invited', {
  address: 'user.invited',
  title: 'User invited',
  description: 'Invitations to join an organization project.',
})
@Controller()
export class UserInvitedEventsHandler {
  @AsyncApiPub({
    operationId: 'publishUserInvited',
    summary: 'Publish a user.invited event.',
  })
  @AsyncApiMessage(userInvitedMessageSource, {
    summary: 'A user was invited to an organization project.',
  })
  @AsyncApiHeaders(eventHeadersSource)
  publishUserInvited(): void {
    // Metadata-only: the decorators above document the event. No body.
  }
}
