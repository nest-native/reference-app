import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '../src/config/env';
import {
  type ClaimerConfig,
  OutboxClaimer,
} from '../src/modules/outbox/outbox-claimer.service';

const logger = new Logger('OutboxWorker');

export interface WorkerLoopConfig {
  pollIntervalMs: number;
  claimer: Partial<ClaimerConfig>;
  signal: AbortSignal;
}

// Run an outbox tick loop until the signal aborts. Each iteration ticks once,
// then waits the poll interval (abort-cancellable). Errors are logged and the
// loop continues — individual event failures are already handled by the
// claimer's retry/backoff.
export async function runWorkerLoop(
  claimer: OutboxClaimer,
  config: WorkerLoopConfig,
): Promise<void> {
  while (!config.signal.aborted) {
    try {
      const report = await claimer.tick(config.claimer);
      if (report.claimed > 0) {
        logger.log(
          `tick claimed=${report.claimed} completed=${report.completed} retried=${report.retried} failed=${report.failed}`,
        );
      }
    } catch (error) {
      logger.error(
        `tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (config.signal.aborted) return;
    try {
      await delay(config.pollIntervalMs, undefined, { signal: config.signal });
    } catch {
      // delay rejects with AbortError on abort; treat as a normal stop signal.
      return;
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const claimer = app.get(OutboxClaimer);

  const controller = new AbortController();
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`received ${signal}, draining current tick…`);
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  logger.log(
    `outbox worker started: db=${env.databaseUrl} poll=${env.outbox.pollIntervalMs}ms batch=${env.outbox.batchSize} stuck=${env.outbox.stuckTimeoutMs}ms`,
  );

  try {
    await runWorkerLoop(claimer, {
      pollIntervalMs: env.outbox.pollIntervalMs,
      claimer: {
        batchSize: env.outbox.batchSize,
        stuckTimeoutMs: env.outbox.stuckTimeoutMs,
        ...(env.outbox.workerInstanceId
          ? { workerInstanceId: env.outbox.workerInstanceId }
          : {}),
      },
      signal: controller.signal,
    });
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await app.close();
    logger.log('outbox worker stopped cleanly');
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
