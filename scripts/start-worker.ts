import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  JobsClaimer,
  runWorkerLoop as runJobsWorkerLoop,
} from '@nest-native/jobs';
import { OutboxRelay } from '@nestjs/outbox';
import { loadEnv } from '../src/config/env';

const logger = new Logger('Worker');

async function main(): Promise<void> {
  const env = loadEnv();
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const relay = app.get(OutboxRelay);
  const jobsClaimer = app.get(JobsClaimer);

  const controller = new AbortController();
  let shuttingDown = false;
  // Both loops stop on the signal. The jobs loop returns once its current tick
  // does, which a long job can stretch; the relay must not go on claiming
  // batches until then, so it stops right away (app.close() awaits it again).
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`received ${signal}, draining current work…`);
    void relay.stop();
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  logger.log(
    `worker started (outbox relay + jobs): db=${env.databaseUrl} poll=${env.outbox.pollIntervalMs}ms batch=${env.outbox.batchSize} lease=${env.outbox.stuckTimeoutMs}ms`,
  );

  // The worker writes read-model rows (activity feed) the API process caches.
  // Without the shared bus its tag invalidations never leave this process, so
  // the API keeps serving stale reads until each entry's TTL lapses.
  if (!env.cacheSocketPath) {
    logger.warn(
      `CACHE_SOCKET_PATH is unset: cross-process cache invalidation is OFF, so API reads can stay stale for up to CACHE_TTL_MS (${env.cacheTtlMs}ms). Set CACHE_SOCKET_PATH to the same socket path in both processes.`,
    );
  }

  // `lost` counts jobs this worker let go without recording an outcome
  // (another worker took them over after stuckTimeoutMs); a steady non-zero
  // value means batches take longer than the stuck timeout.
  const reportTick = (report: {
    claimed: number;
    completed: number;
    retried: number;
    failed: number;
    lost: number;
  }) => {
    if (report.claimed > 0) {
      logger.log(
        `jobs tick claimed=${report.claimed} completed=${report.completed} retried=${report.retried} failed=${report.failed} lost=${report.lost}`,
      );
    }
  };

  // The outbox relay is off in every process AppModule boots; this is the one
  // that runs it. It polls on its own timer (draining at once while batches
  // come back full), retries with backoff, dead-letters what never succeeds,
  // and logs its own retries, dead letters and store failures.
  relay.start();
  try {
    // The jobs loop is the library's own: tick → drain immediately when a
    // batch was claimed, otherwise wait the poll interval (abort-cancellable).
    // It shares the poll/batch/stuck knobs with the relay — generic worker
    // tuning, not outbox-specific — and stops on the same signal.
    await runJobsWorkerLoop(jobsClaimer, {
      pollIntervalMs: env.outbox.pollIntervalMs,
      runner: {
        batchSize: env.outbox.batchSize,
        stuckTimeoutMs: env.outbox.stuckTimeoutMs,
        // Unset keeps the library default (`<hostname>-<pid>`).
        workerInstanceId: env.outbox.workerInstanceId,
      },
      signal: controller.signal,
      onTick: reportTick,
      onError: (error: unknown) => {
        logger.error(
          `jobs tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    // Closing the app stops the relay first (onModuleDestroy), or waits for
    // the stop the signal began: it stops claiming, lets in-flight publishes
    // settle and releases the leases on messages it had not started.
    await app.close();
    logger.log('worker stopped cleanly');
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
