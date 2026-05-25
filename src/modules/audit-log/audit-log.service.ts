import { Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import type { AppDatabase } from '../../database/database';
import {
  type AuditEvent,
  auditEvents,
} from '../../database/schema';

export interface RecordAuditEventInput {
  orgId: number;
  actorUserId: number;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  record(input: RecordAuditEventInput): AuditEvent {
    return this.db
      .insert(auditEvents)
      .values({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }
}
