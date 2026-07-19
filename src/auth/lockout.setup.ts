import { Logger, Module } from '@nestjs/common';
import { SqliteLockoutStore } from '@authlock/core/sqlite';
import { getDrizzleClientToken } from '@nest-native/drizzle';
import { LockoutModule } from '@nest-native/lockout';
import { loadEnv } from '../config/env';
import type { AppDatabase } from '../database/database';
import { lockoutAttempts } from '../database/schema';

/**
 * Wires @authlock/core into the app: a Drizzle-backed lockout store on the SAME
 * SQLite database as everything else (its atomic increment counts failed logins
 * exactly once, even across instances), keyed by email OR source IP. The counter
 * is written on the base Drizzle connection — deliberately NOT inside the request
 * transaction — so a failed attempt is recorded even if the login transaction
 * rolls back. `LockoutService` is global (LockoutModule default), so AuthService
 * injects it directly.
 */
@Module({
  imports: [
    LockoutModule.forRootAsync({
      // The drizzle client token is global (see DatabaseModule), so the store
      // factory resolves the base Drizzle instance directly.
      inject: [getDrizzleClientToken()],
      useFactory: (db: AppDatabase) => {
        const env = loadEnv();
        const logger = new Logger('Lockout');
        return {
          store: new SqliteLockoutStore(db, lockoutAttempts),
          limit: env.lockoutLimit,
          cooloffMs: env.lockoutCooloffMs,
          // A lock trips if EITHER the email OR the source IP crosses the limit.
          parameters: [['email'], ['ip']],
          logger: (error, context) =>
            logger.error(`lockout store error (${context})`, error),
        };
      },
    }),
  ],
})
export class AppLockoutModule {}
