import { hostname } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { InjectDrizzle } from '@nest-native/drizzle';
import type { AppDatabase } from '../../database/database';
import {
  type OutboxEvent,
  outboxEvents,
} from '../../database/schema';
import { OutboxRegistry } from './outbox-registry.service';

export interface ClaimerConfig {
  workerInstanceId: string;
  stuckTimeoutMs: number;
  batchSize: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_CLAIMER_CONFIG: ClaimerConfig = {
  workerInstanceId: `${hostname()}-${process.pid}`,
  stuckTimeoutMs: 60_000,
  batchSize: 32,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

export interface TickReport {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

@Injectable()
export class OutboxClaimer {
  private readonly logger = new Logger(OutboxClaimer.name);

  constructor(
    @InjectDrizzle() private readonly db: AppDatabase,
    @Inject(OutboxRegistry) private readonly registry: OutboxRegistry,
  ) {}

  async tick(overrides: Partial<ClaimerConfig> = {}): Promise<TickReport> {
    const cfg = { ...DEFAULT_CLAIMER_CONFIG, ...overrides };
    const claimed = this.claimBatch(cfg);
    const report: TickReport = {
      claimed: claimed.length,
      completed: 0,
      retried: 0,
      failed: 0,
    };

    for (const event of claimed) {
      const outcome = await this.processOne(event, cfg);
      report[outcome] += 1;
    }
    return report;
  }

  private claimBatch(cfg: ClaimerConfig): OutboxEvent[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const stuckCutoff = new Date(now.getTime() - cfg.stuckTimeoutMs).toISOString();

    return this.db.transaction((tx) => {
      const candidates = tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          or(
            and(
              eq(outboxEvents.status, 'pending'),
              lte(outboxEvents.availableAt, nowIso),
            ),
            and(
              eq(outboxEvents.status, 'processing'),
              lte(outboxEvents.claimedAt, stuckCutoff),
            ),
          ),
        )
        .limit(cfg.batchSize)
        .all();

      if (candidates.length === 0) return [];

      const ids = candidates.map((c) => c.id);
      tx.update(outboxEvents)
        .set({
          status: 'processing',
          claimedAt: nowIso,
          claimedBy: cfg.workerInstanceId,
        })
        .where(inArray(outboxEvents.id, ids))
        .run();

      return tx
        .select()
        .from(outboxEvents)
        .where(inArray(outboxEvents.id, ids))
        .all();
    });
  }

  private async processOne(
    event: OutboxEvent,
    cfg: ClaimerConfig,
  ): Promise<'completed' | 'retried' | 'failed'> {
    const handler = this.registry.get(event.topic);
    if (!handler) {
      return this.markFailed(event, `no handler registered for topic "${event.topic}"`);
    }

    try {
      const result = await handler(event.payload);
      if (result === 'completed') {
        this.markCompleted(event);
        return 'completed';
      }
      return this.retry(event, cfg, result.retryAfterMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (event.attempts + 1 >= event.maxAttempts) {
        return this.markFailed(event, message);
      }
      return this.retry(event, cfg, this.backoff(event.attempts, cfg), message);
    }
  }

  private markCompleted(event: OutboxEvent): void {
    this.db
      .update(outboxEvents)
      .set({
        status: 'completed',
        processedAt: new Date().toISOString(),
        lastError: null,
      })
      .where(eq(outboxEvents.id, event.id))
      .run();
  }

  private retry(
    event: OutboxEvent,
    cfg: ClaimerConfig,
    delayMs: number,
    lastError?: string,
  ): 'retried' {
    const nextAvailable = new Date(Date.now() + delayMs).toISOString();
    this.db
      .update(outboxEvents)
      .set({
        status: 'pending',
        attempts: sql`${outboxEvents.attempts} + 1`,
        availableAt: nextAvailable,
        claimedAt: null,
        claimedBy: null,
        lastError: lastError ?? null,
      })
      .where(eq(outboxEvents.id, event.id))
      .run();
    return 'retried';
  }

  private markFailed(event: OutboxEvent, reason: string): 'failed' {
    this.logger.warn(`outbox event ${event.id} failed: ${reason}`);
    this.db
      .update(outboxEvents)
      .set({
        status: 'failed',
        attempts: sql`${outboxEvents.attempts} + 1`,
        lastError: reason,
        processedAt: new Date().toISOString(),
      })
      .where(eq(outboxEvents.id, event.id))
      .run();
    return 'failed';
  }

  private backoff(attempts: number, cfg: ClaimerConfig): number {
    const base = cfg.baseBackoffMs * 2 ** attempts;
    const capped = Math.min(base, cfg.maxBackoffMs);
    return capped + Math.floor(Math.random() * cfg.baseBackoffMs);
  }
}
