import { Module } from '@nestjs/common';
import { AsyncApiModule } from '@nest-native/asyncapi';
import { EVENTS_CATALOG_INFO } from './event-schemas';
import {
  TaskAssignedEventsHandler,
  TaskCompletedEventsHandler,
  TaskCreatedEventsHandler,
} from './task-events.handler';
import { UserInvitedEventsHandler } from './user-events.handler';

/**
 * The AsyncAPI 3.0 event catalog.
 *
 * Registers the global `@nest-native/asyncapi` configuration and the
 * documentation-only handler controllers whose decorators describe the domain
 * events the app publishes to Kafka. The handlers expose no HTTP routes and no
 * runtime behaviour; they exist purely so `getAsyncApiDocument` (called in
 * `main.ts`) can discover their metadata and emit the catalog. Generating and
 * serving the catalog needs no Kafka connection — it is pure metadata.
 */
@Module({
  imports: [
    AsyncApiModule.forRoot({
      defaultInfo: {
        title: EVENTS_CATALOG_INFO.title,
        version: EVENTS_CATALOG_INFO.version,
      },
    }),
  ],
  controllers: [
    UserInvitedEventsHandler,
    TaskCreatedEventsHandler,
    TaskAssignedEventsHandler,
    TaskCompletedEventsHandler,
  ],
})
export class EventsCatalogModule {}
