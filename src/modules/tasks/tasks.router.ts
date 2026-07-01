import { Inject, UseGuards } from '@nestjs/common';
import { Input, Mutation, Query, Router } from '@nest-native/trpc';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import { TasksService } from './tasks.service';

const TaskSchema = z.object({
  id: z.number(),
  orgId: z.number(),
  projectId: z.number(),
  title: z.string(),
  status: z.enum(['open', 'in_progress', 'done']),
  assigneeId: z.number().nullable(),
  createdBy: z.number(),
  createdAt: z.string(),
});

const CreateTaskInputSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(1).max(200),
});

const AssignTaskInputSchema = z.object({
  id: z.number().int().positive(),
  assigneeId: z.number().int().positive(),
});

const CompleteTaskInputSchema = z.object({
  id: z.number().int().positive(),
});

const ListTasksInputSchema = z.object({
  projectId: z.number().int().positive(),
});

@Router('tasks')
@UseGuards(AuthGuard)
export class TasksRouter {
  constructor(@Inject(TasksService) private readonly service: TasksService) {}

  @Query({ input: ListTasksInputSchema, output: z.array(TaskSchema) })
  list(@Input('projectId') projectId: number) {
    return this.service.listTasks(projectId);
  }

  @Mutation({ input: CreateTaskInputSchema, output: TaskSchema })
  create(@Input() input: z.infer<typeof CreateTaskInputSchema>) {
    return this.service.createTask(input);
  }

  @Mutation({ input: AssignTaskInputSchema, output: TaskSchema })
  assign(@Input() input: z.infer<typeof AssignTaskInputSchema>) {
    return this.service.assignTask(input);
  }

  @Mutation({ input: CompleteTaskInputSchema, output: TaskSchema })
  complete(@Input('id') id: number) {
    return this.service.completeTask(id);
  }
}
