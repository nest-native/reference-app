import { Inject, UseGuards } from '@nestjs/common';
import { Input, Mutation, Query, Router } from '@nest-native/trpc';
import { CacheService } from '@nest-native/cache';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import type { CurrentOrganizationContext } from '../../auth/auth-context';
import { CURRENT_ORGANIZATION } from '../../context/request-context.module';
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

/**
 * Project reads are cached at the API seam (the service stays synchronous and
 * cache-free): keys carry the org dimension for tenancy, and every entry is
 * tagged so the create mutation — and any future project mutation — evicts
 * precisely. The TTL is only the backstop; the tags do the real work.
 */
@Router('projects')
@UseGuards(AuthGuard)
export class ProjectsRouter {
  constructor(
    @Inject(ProjectsService) private readonly service: ProjectsService,
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
  ) {}

  @Query({ output: z.array(ProjectSchema) })
  list() {
    const orgId = this.currentOrg?.id;
    if (orgId === undefined) {
      return this.service.list(); // service raises the canonical error
    }
    return this.cache.wrap(
      `org:${orgId}:projects`,
      () => this.service.list(),
      { tags: [`org:${orgId}:projects`] },
    );
  }

  @Query({ input: GetProjectInputSchema, output: ProjectSchema })
  get(@Input('id') id: number) {
    const orgId = this.currentOrg?.id;
    if (orgId === undefined) {
      return this.service.get(id);
    }
    return this.cache.wrap(
      `org:${orgId}:project:${id}`,
      () => this.service.get(id),
      { tags: [`org:${orgId}:projects`, `project:${id}`] },
    );
  }

  @Mutation({ input: CreateProjectInputSchema, output: ProjectSchema })
  async create(@Input() input: z.infer<typeof CreateProjectInputSchema>) {
    const project = this.service.create(input);
    // Evict the org's project reads everywhere (tags fan out over the bus).
    await this.cache.invalidateTags([`org:${project.orgId}:projects`]);
    return project;
  }
}
