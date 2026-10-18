import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { JobHandler, JobSchedulesService } from '@nest-native/jobs';
import type { SqliteScheduleStore } from '@nest-native/jobs/sqlite';
import { OutboxInbox } from '@nestjs/outbox';

/** Job name for the nightly prune of the consumers' inbox. */
export const JOB_OUTBOX_INBOX_PRUNE = 'outbox.inbox-prune' as const;

/** Schedule identity (the `job_schedules.name` the boot-time upsert keys on). */
export const SCHEDULE_OUTBOX_INBOX_PRUNE = 'nightly-outbox-inbox-prune' as const;

/**
 * How long a consumer remembers a message it processed. It has to outlast
 * every redelivery, a dead letter requeued by hand included.
 */
export const OUTBOX_INBOX_RETENTION = '30d' as const;

/**
 * The consumers' inbox gains a record per message and consumer, in every
 * profile, and `@nestjs/outbox` never prunes it: its production checklist
 * leaves `OutboxInbox.prune()` to a cron job. This is that job, on the jobs
 * library's DB-stored schedules like the stale-task sweep: it deletes the
 * records older than {@link OUTBOX_INBOX_RETENTION}. A second run of one
 * occurrence finds nothing more to delete, so at-least-once is enough.
 */
@JobHandler(JOB_OUTBOX_INBOX_PRUNE)
@Injectable()
export class InboxPruneHandler implements JobHandler {
  constructor(@Inject(OutboxInbox) private readonly inbox: OutboxInbox) {}

  async handle(): Promise<void> {
    await this.inbox.prune(OUTBOX_INBOX_RETENTION);
  }
}

/**
 * Declares the nightly inbox prune as a `job_schedules` row at bootstrap, the
 * way {@link import('../reminders/stale-task-schedule.setup').StaleTaskScheduleSetup}
 * declares the sweep (the upsert keeps a runtime `enabled` flag and the next
 * run). Its `uniqueKey` stops a slow prune and the next one from overlapping.
 */
@Injectable()
export class InboxPruneScheduleSetup implements OnApplicationBootstrap {
  constructor(
    @Inject(JobSchedulesService)
    private readonly schedules: JobSchedulesService<SqliteScheduleStore>,
  ) {}

  onApplicationBootstrap(): void {
    this.schedules.upsert({
      name: SCHEDULE_OUTBOX_INBOX_PRUNE,
      jobName: JOB_OUTBOX_INBOX_PRUNE,
      // 03:30 UTC, after the stale-task sweep.
      cron: '30 3 * * *',
      uniqueKey: SCHEDULE_OUTBOX_INBOX_PRUNE,
    });
  }
}
