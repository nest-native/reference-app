import { Inject, NotFoundException, UseGuards } from '@nestjs/common';
import { Input, Query, Router } from '@nest-native/trpc';
import { CacheService } from '@nest-native/cache';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import type { CurrentOrganizationContext } from '../../auth/auth-context';
import { CURRENT_ORGANIZATION } from '../../context/request-context.module';
import { ActivityService } from './activity.service';

const ActivityEventSchema = z.object({
  id: z.number(),
  orgId: z.number(),
  projectId: z.number().nullable(),
  type: z.string(),
  actorUserId: z.number().nullable(),
  summary: z.string(),
  dedupKey: z.string(),
  // A real `Date` on the API contract (the read model stores ISO-8601 text).
  // The superjson transformer keeps it a `Date` instance across the wire —
  // without it, JSON would silently degrade it to a string.
  createdAt: z.date(),
});

const ListActivityInputSchema = z.object({
  projectId: z.number().int().positive(),
});

/**
 * Read side of the activity feed. Tenant resolution lives here (not in
 * ActivityService) because the service is a singleton shared with the outbox
 * handler / inbox consumer, which run outside any request and therefore cannot
 * inject the request-scoped CURRENT_ORGANIZATION.
 */
@Router('activity')
@UseGuards(AuthGuard)
export class ActivityRouter {
  constructor(
    @Inject(ActivityService) private readonly service: ActivityService,
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
  ) {}

  @Query({ input: ListActivityInputSchema, output: z.array(ActivityEventSchema) })
  async list(@Input('projectId') projectId: number) {
    if (!this.currentOrg) {
      throw new NotFoundException('No active organization for this session');
    }
    // The RAW rows are what gets cached; the Date mapping runs per response
    // (mapping before caching would hand every hit the same mapped objects —
    // cached values must be treated as immutable).
    const rows = await this.cache.wrap(
      `org:${this.currentOrg.id}:project:${projectId}:activity`,
      () => this.service.list(this.currentOrg!.id, projectId),
      { tags: [`project:${projectId}:activity`] },
    );
    return rows.map((event) => ({ ...event, createdAt: new Date(event.createdAt) }));
  }
}
