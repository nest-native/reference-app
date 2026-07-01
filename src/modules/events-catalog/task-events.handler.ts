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
  taskAssignedMessageSource,
  taskCompletedMessageSource,
  taskCreatedMessageSource,
} from './event-schemas';

/**
 * Documentation-only handlers for the task lifecycle events. Each of the three
 * events is published to its own Kafka topic (`task.created`, `task.assigned`,
 * `task.completed`), so each is documented as its own channel whose address is
 * that exact topic — mirroring the outbox topics one-to-one. The handlers carry
 * no runtime behaviour; the outbox (see `src/modules/tasks` +
 * `src/modules/outbox`) is what actually publishes the events.
 */

@AsyncApiServer(KAFKA_SERVER_NAME, KAFKA_SERVER_HOST, 'kafka', kafkaServerOptions)
@AsyncApiChannel('task.created', {
  address: 'task.created',
  title: 'Task created',
  description: 'A task was created in a project.',
})
@Controller()
export class TaskCreatedEventsHandler {
  @AsyncApiPub({
    operationId: 'publishTaskCreated',
    summary: 'Publish a task.created event.',
  })
  @AsyncApiMessage(taskCreatedMessageSource, {
    summary: 'A task was created.',
  })
  @AsyncApiHeaders(eventHeadersSource)
  publishTaskCreated(): void {
    // Metadata-only: the decorators above document the event. No body.
  }
}

@AsyncApiServer(KAFKA_SERVER_NAME, KAFKA_SERVER_HOST, 'kafka', kafkaServerOptions)
@AsyncApiChannel('task.assigned', {
  address: 'task.assigned',
  title: 'Task assigned',
  description: 'A task was assigned to a user.',
})
@Controller()
export class TaskAssignedEventsHandler {
  @AsyncApiPub({
    operationId: 'publishTaskAssigned',
    summary: 'Publish a task.assigned event.',
  })
  @AsyncApiMessage(taskAssignedMessageSource, {
    summary: 'A task was assigned to a user.',
  })
  @AsyncApiHeaders(eventHeadersSource)
  publishTaskAssigned(): void {
    // Metadata-only: the decorators above document the event. No body.
  }
}

@AsyncApiServer(KAFKA_SERVER_NAME, KAFKA_SERVER_HOST, 'kafka', kafkaServerOptions)
@AsyncApiChannel('task.completed', {
  address: 'task.completed',
  title: 'Task completed',
  description: 'A task was marked complete.',
})
@Controller()
export class TaskCompletedEventsHandler {
  @AsyncApiPub({
    operationId: 'publishTaskCompleted',
    summary: 'Publish a task.completed event.',
  })
  @AsyncApiMessage(taskCompletedMessageSource, {
    summary: 'A task was marked complete.',
  })
  @AsyncApiHeaders(eventHeadersSource)
  publishTaskCompleted(): void {
    // Metadata-only: the decorators above document the event. No body.
  }
}
