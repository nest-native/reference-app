import { Injectable } from '@nestjs/common';

export type OutboxHandlerResult = 'completed' | { retryAfterMs: number };

export type OutboxHandler = (
  payload: Record<string, unknown>,
) => Promise<OutboxHandlerResult> | OutboxHandlerResult;

@Injectable()
export class OutboxRegistry {
  private readonly handlers = new Map<string, OutboxHandler>();

  register(topic: string, handler: OutboxHandler): void {
    if (this.handlers.has(topic)) {
      throw new Error(`Outbox handler already registered for topic "${topic}"`);
    }
    this.handlers.set(topic, handler);
  }

  get(topic: string): OutboxHandler | undefined {
    return this.handlers.get(topic);
  }
}
