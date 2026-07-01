import { Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { and, desc, eq } from 'drizzle-orm';
import { DrizzleRepository } from '@nest-native/drizzle';
import type { AppDatabase } from '../../database/database';
import { type Task, tasks } from '../../database/schema';

export interface CreateTaskInput {
  orgId: number;
  projectId: number;
  title: string;
  createdBy: number;
}

@Injectable()
@DrizzleRepository()
export class TasksRepository {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  create(input: CreateTaskInput): Task {
    return this.db
      .insert(tasks)
      .values({
        orgId: input.orgId,
        projectId: input.projectId,
        title: input.title,
        status: 'open',
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }

  assign(orgId: number, id: number, assigneeId: number): Task | undefined {
    return this.db
      .update(tasks)
      .set({ assigneeId, status: 'in_progress' })
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
      .returning()
      .get();
  }

  complete(orgId: number, id: number): Task | undefined {
    return this.db
      .update(tasks)
      .set({ status: 'done' })
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
      .returning()
      .get();
  }

  listForProject(orgId: number, projectId: number): Task[] {
    return this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), eq(tasks.projectId, projectId)))
      .orderBy(desc(tasks.id))
      .all();
  }

  findById(orgId: number, id: number): Task | undefined {
    return this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
      .get();
  }
}
