import { Inject, UseGuards } from '@nestjs/common';
import { Input, Mutation, Query, Router } from '@nest-native/trpc';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import { ProjectsService } from './projects.service';

const ProjectSchema = z.object({
  id: z.number(),
  orgId: z.number(),
  name: z.string(),
  createdBy: z.number(),
  createdAt: z.string(),
});

const CreateProjectInputSchema = z.object({
  name: z.string().min(1).max(120),
});

const GetProjectInputSchema = z.object({
  id: z.number().int().positive(),
});

@Router('projects')
@UseGuards(AuthGuard)
export class ProjectsRouter {
  constructor(
    @Inject(ProjectsService) private readonly service: ProjectsService,
  ) {}

  @Query({ output: z.array(ProjectSchema) })
  list() {
    return this.service.list();
  }

  @Query({ input: GetProjectInputSchema, output: ProjectSchema })
  get(@Input('id') id: number) {
    return this.service.get(id);
  }

  @Mutation({ input: CreateProjectInputSchema, output: ProjectSchema })
  create(@Input() input: z.infer<typeof CreateProjectInputSchema>) {
    return this.service.create(input);
  }
}
