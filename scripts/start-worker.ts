import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  JobsClaimer,
  runWorkerLoop as runJobsWorkerLoop,
} from '@nest-native/jobs';
import {
  OutboxClaimer,
  runWorkerLoop as runOutboxWorkerLoop,
} from '@nest-native/messaging';
import { loadEnv } from '../src/config/env';

const logger = new Logger('Worker');

async function main(): Promise<void> {
  const env = loadEnv();
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const outboxClaimer = app.get(OutboxClaimer);
  const jobsClaimer = app.get(JobsClaimer);

  const controller = new AbortController();
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`received ${signal}, draining current ticks…`);
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  logger.log(
    `worker started (outbox + jobs): db=${env.databaseUrl} poll=${env.outbox.pollIntervalMs}ms batch=${env.outbox.batchSize} stuck=${env.outbox.stuckTimeoutMs}ms`,
  );

  const reportTick = (
    loop: string,
    report: { claimed: number; completed: number; retried: number; failed: number },
  ) => {
    if (report.claimed > 0) {
      logger.log(
        `${loop} tick claimed=${report.claimed} completed=${report.completed} retried=${report.retried} failed=${report.failed}`,
      );
    }
  };
  const reportError = (loop: string) => (error: unknown) => {
    logger.error(
      `${loop} tick failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  try {
    // Both loops are the libraries' own: tick → drain immediately when a batch
    // was claimed, otherwise wait the poll interval (abort-cancellable). They
    // share the poll/batch/stuck knobs — generic worker tuning, not
    // outbox-specific — and the same abort signal, so one SIGTERM drains both.
    // Individual event/job failures are already handled by each claimer's
    // retry/backoff.
    await Promise.all([
      runOutboxWorkerLoop(outboxClaimer, {
        pollIntervalMs: env.outbox.pollIntervalMs,
        claimer: {
          batchSize: env.outbox.batchSize,
          stuckTimeoutMs: env.outbox.stuckTimeoutMs,
          ...(env.outbox.workerInstanceId
            ? { workerInstanceId: env.outbox.workerInstanceId }
            : {}),
        },
        signal: controller.signal,
        onTick: (report) => reportTick('outbox', report),
        onError: reportError('outbox'),
      }),
      runJobsWorkerLoop(jobsClaimer, {
        pollIntervalMs: env.outbox.pollIntervalMs,
        runner: {
          batchSize: env.outbox.batchSize,
          stuckTimeoutMs: env.outbox.stuckTimeoutMs,
          ...(env.outbox.workerInstanceId
            ? { workerInstanceId: env.outbox.workerInstanceId }
            : {}),
        },
        signal: controller.signal,
        onTick: (report) => reportTick('jobs', report),
        onError: reportError('jobs'),
      }),
    ]);
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
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
