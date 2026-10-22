import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/**
 * Creates the HTTP application the way `main.ts` runs it, for the server and
 * the tests alike.
 *
 * Compressed request bodies are refused with 415. Nothing sends them to this
 * API, and `inflate: false` keeps Express's body parser from handing a
 * `Content-Encoding: br`, gzip or deflate body to Node's zlib before any guard
 * has run. The image runs on the Node it was built from, and Node's Brotli
 * decoder carried a remote code execution fix in October 2026
 * (CVE-2026-111497): a rebuilt image is the first defence, this is the second.
 */
export async function createApp(options: NestApplicationOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...options,
    bodyParser: false,
  });
  app.useBodyParser('json', { inflate: false });
  app.useBodyParser('urlencoded', { extended: true, inflate: false });
  return app;
}
