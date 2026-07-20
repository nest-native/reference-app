import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CacheModule } from '@nest-native/cache';
import type { InvalidationBus } from '@stalefree/core';
import { SocketInvalidationBus } from '@stalefree/core/socket';
import { loadEnv } from '../config/env';

/**
 * Wires @stalefree/core into the app: an in-memory L1 read cache with
 * tag-based invalidation. TTL (CACHE_TTL_MS, default 30s) is the delivery
 * backstop — a missed invalidation can only serve stale until the TTL, never
 * forever.
 *
 * Coherence: in the DEFAULT profile the whole app is one process, so the
 * cache is exactly coherent with no bus at all. When the outbox/jobs worker
 * runs as a SEPARATE process (`npm run start:worker`) it writes activity rows
 * the app has cached — set CACHE_SOCKET_PATH (the same value in both
 * processes) and the socket bus carries invalidations across: the worker's
 * projection writes evict the app's L1. No L2 store: the database is a local
 * SQLite file, so a shared warm tier would just duplicate it.
 */
export const CACHE_BUS = Symbol.for('reference-app:cache-bus');

const logger = new Logger('Cache');

@Injectable()
class CacheBusLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(CACHE_BUS) private readonly bus: InvalidationBus | undefined,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.bus?.close?.();
  }
}

@Module({
  providers: [
    {
      provide: CACHE_BUS,
      useFactory: async (): Promise<InvalidationBus | undefined> => {
        const env = loadEnv();
        if (!env.cacheSocketPath) {
          return undefined; // single-process profile: L1 is coherent as-is
        }
        const bus = new SocketInvalidationBus({
          path: env.cacheSocketPath,
          onError: (error) => logger.error('cache bus error', error),
        });
        await bus.start();
        return bus;
      },
    },
    CacheBusLifecycle,
  ],
  exports: [CACHE_BUS],
})
class CacheBusModule {}

@Module({
  imports: [
    CacheModule.forRootAsync({
      imports: [CacheBusModule],
      inject: [CACHE_BUS],
      useFactory: (bus: InvalidationBus | undefined) => {
        const env = loadEnv();
        return {
          defaultTtlMs: env.cacheTtlMs,
          bus,
          onError: (error, context) =>
            logger.error(`cache error (${context})`, error),
        };
      },
    }),
  ],
})
export class AppCacheModule {}
