import { Inject, NotFoundException, UseGuards } from '@nestjs/common';
import { Input, Query, Router } from '@nest-native/trpc';
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
  createdAt: z.string(),
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
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
  ) {}

  @Query({ input: ListActivityInputSchema, output: z.array(ActivityEventSchema) })
  list(@Input('projectId') projectId: number) {
    if (!this.currentOrg) {
      throw new NotFoundException('No active organization for this session');
    }
    return this.service.list(this.currentOrg.id, projectId);
  }
}
