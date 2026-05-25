import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import type { AppDatabase } from '../../database/database';
import {
  type OutboxEvent,
  outboxEvents,
} from '../../database/schema';

export interface EnqueueOutboxInput {
  topic: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  availableAt?: Date;
}

@Injectable()
export class OutboxProducer {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  enqueue(input: EnqueueOutboxInput): OutboxEvent {
    const now = new Date().toISOString();
    return this.db
      .insert(outboxEvents)
      .values({
        id: randomUUID(),
        topic: input.topic,
        payload: input.payload,
        status: 'pending',
        idempotencyKey: input.idempotencyKey,
        availableAt: (input.availableAt ?? new Date()).toISOString(),
        createdAt: now,
      })
      .returning()
      .get();
  }
}
