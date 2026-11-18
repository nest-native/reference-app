import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/**
 * Creates the HTTP application the way `main.ts` runs it, for the server and
 * the tests alike.
 *
 * The Express adapter is created here, not by `NestFactory`: given none,
 * NestJS 12 loads `@nestjs/platform-express` with its own `import()`, which
 * under tsx brings a second copy of `@nestjs/common`. The adapter would then
 * wrap body-parser errors, the 415 below included, in an `HttpException` the
 * exception filter does not recognise, so they would be answered 500
 * (GUIDELINES_NEST_REFERENCE_APP.md §7).
 *
 * Compressed request bodies are refused with 415. Nothing sends them to this
 * API, and `inflate: false` keeps Express's body parser from handing a
 * `Content-Encoding: br`, gzip or deflate body to Node's zlib before any guard
 * has run. The image runs on the Node it was built from, and Node's Brotli
 * decoder carried a remote code execution fix in October 2026
 * (CVE-2026-111497): a rebuilt image is the first defence, this is the second.
 */
export async function createApp(options: NestApplicationOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), {
    ...options,
    bodyParser: false,
  });
  app.useBodyParser('json', { inflate: false });
  app.useBodyParser('urlencoded', { extended: true, inflate: false });
  return app;
}
