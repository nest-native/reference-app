import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxClaimer, runWorkerLoop } from '@nest-native/messaging';
import { loadEnv } from '../src/config/env';

const logger = new Logger('OutboxWorker');

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
    // The loop is the library's: tick → drain immediately when a batch was
    // claimed, otherwise wait the poll interval (abort-cancellable). Errors are
    // logged via onError and the loop continues — individual event failures are
    // already handled by the claimer's retry/backoff.
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
      onTick: (report) => {
        if (report.claimed > 0) {
          logger.log(
            `tick claimed=${report.claimed} completed=${report.completed} retried=${report.retried} failed=${report.failed}`,
          );
        }
      },
      onError: (error) => {
        logger.error(
          `tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
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
