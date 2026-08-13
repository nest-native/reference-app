import { Inject, UseGuards } from '@nestjs/common';
import { Input, Mutation, Query, Router } from '@nest-native/trpc';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
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

// Guards compose left to right: AuthGuard proves the caller, RolesGuard reads
// their live membership role for the procedures that declare @Roles. Reads
// declare none, so they stay token-trusted.
@Router('tasks')
@UseGuards(AuthGuard, RolesGuard)
export class TasksRouter {
  constructor(@Inject(TasksService) private readonly service: TasksService) {}

  @Query({ input: ListTasksInputSchema, output: z.array(TaskSchema) })
  list(@Input('projectId') projectId: number) {
    return this.service.listTasks(projectId);
  }

  @Roles('admin', 'member')
  @Mutation({ input: CreateTaskInputSchema, output: TaskSchema })
  create(@Input() input: z.infer<typeof CreateTaskInputSchema>) {
    return this.service.createTask(input);
  }

  @Roles('admin', 'member')
  @Mutation({ input: AssignTaskInputSchema, output: TaskSchema })
  assign(@Input() input: z.infer<typeof AssignTaskInputSchema>) {
    return this.service.assignTask(input);
  }

  @Roles('admin', 'member')
  @Mutation({ input: CompleteTaskInputSchema, output: TaskSchema })
  complete(@Input('id') id: number) {
    return this.service.completeTask(id);
  }
}
