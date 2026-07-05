// The `jobs` table ships from the jobs library so the app and the engine reason
// about byte-identical DDL (same columns, defaults, the FULL unique index on
// (name, unique_key) that scopes dedup to ACTIVE jobs, and the
// (status, available_at) claim index) — the same precedent as the messaging
// tables. Row types are derived from the imported table; the status union/const
// comes from the library core.
import { jobs } from '@nest-native/jobs/sqlite';

export { jobs };
export { JOB_STATUSES, type JobStatus } from '@nest-native/jobs';

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
