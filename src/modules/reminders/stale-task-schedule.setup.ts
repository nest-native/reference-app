import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { JobSchedulesService } from '@nest-native/jobs';
import type { SqliteScheduleStore } from '@nest-native/jobs/sqlite';
import {
  JOB_STALE_TASK_SWEEP,
  SCHEDULE_STALE_TASK_SWEEP,
} from './reminders.constants';

/**
 * Declares the nightly stale-task sweep as a `job_schedules` row at bootstrap.
 *
 * Upserting on every boot is the documented pattern, and it is safe precisely
 * because of two guarantees `@nest-native/jobs` makes about the conflict path:
 * an omitted `enabled` PRESERVES the stored flag (so disabling the sweep at
 * runtime with `setEnabled(name, false)` survives the next deploy), and the
 * stored `next_run_at` is preserved while the cron and timezone are unchanged
 * (so a redeploy neither skips a pending catch-up nor shifts the rhythm).
 * Changing the cron here re-arms it from now.
 *
 * The schedule carries a `uniqueKey`, which makes an occurrence a dedup no-op
 * while the previous one is still active — with a sweep that is proportional to
 * the number of open tasks, that overlap guard is what keeps a slow night from
 * stacking runs.
 */
@Injectable()
export class StaleTaskScheduleSetup implements OnApplicationBootstrap {
  constructor(
    @Inject(JobSchedulesService)
    private readonly schedules: JobSchedulesService<SqliteScheduleStore>,
  ) {}

  onApplicationBootstrap(): void {
    this.schedules.upsert({
      name: SCHEDULE_STALE_TASK_SWEEP,
      jobName: JOB_STALE_TASK_SWEEP,
      // 03:00 UTC — the library defaults to UTC rather than server-local so a
      // schedule means the same thing on every instance.
      cron: '0 3 * * *',
      uniqueKey: SCHEDULE_STALE_TASK_SWEEP,
    });
  }
}
