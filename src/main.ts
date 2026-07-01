import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AsyncApiModule, getAsyncApiDocument } from '@nest-native/asyncapi';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { EVENTS_CATALOG_INFO } from './modules/events-catalog/event-schemas';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);

  // Generate the AsyncAPI 3.0 event catalog from the decorated handlers and
  // serve it (UI + JSON + YAML). This is pure metadata, so it is always on and
  // needs no Kafka connection. Mirrors SwaggerModule.setup: call before listen.
  const asyncApiDocument = getAsyncApiDocument(app, {
    title: EVENTS_CATALOG_INFO.title,
    version: EVENTS_CATALOG_INFO.version,
    description: EVENTS_CATALOG_INFO.description,
  });
  AsyncApiModule.setup('/asyncapi', app, asyncApiDocument, {
    title: EVENTS_CATALOG_INFO.title,
  });

  await app.listen(env.port);

  const url = await app.getUrl();
  console.warn(`Reference app listening on ${url}`);
  console.warn(`Health endpoint:  ${url}/health`);
  console.warn(`tRPC endpoint:    ${url}${env.trpcPath}`);
  console.warn(`AsyncAPI catalog: ${url}/asyncapi (JSON: /asyncapi-json)`);
}

void bootstrap();
