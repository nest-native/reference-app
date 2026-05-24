import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.port);

  const url = await app.getUrl();
  console.warn(`Reference app listening on ${url}`);
  console.warn(`Health endpoint: ${url}/health`);
  console.warn(`tRPC endpoint:   ${url}${env.trpcPath}`);
}

void bootstrap();
