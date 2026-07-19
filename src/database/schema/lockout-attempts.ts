// The lockout counter table ships from @authlock/core so the app and the engine
// reason about byte-identical DDL (key PK, failures, first_failure_at,
// last_failure_at) — the same precedent as the jobs and messaging tables. The
// engine's SqliteLockoutStore is constructed with this exact table instance
// (see auth/lockout.setup.ts), so it is created once here and shared.
import { sqliteLockoutTable } from '@authlock/core/sqlite';

export const lockoutAttempts = sqliteLockoutTable('lockout_attempts');

export type LockoutAttempt = typeof lockoutAttempts.$inferSelect;
export type NewLockoutAttempt = typeof lockoutAttempts.$inferInsert;
