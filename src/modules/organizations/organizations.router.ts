import { Inject, UseGuards } from '@nestjs/common';
import { Query, Router } from '@nest-native/trpc';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
import { OrganizationsService } from './organizations.service';

const OrganizationSchema = z.object({
  id: z.number(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

@Router('organizations')
@UseGuards(AuthGuard)
export class OrganizationsRouter {
  constructor(
    @Inject(OrganizationsService)
    private readonly service: OrganizationsService,
  ) {}

  @Query({ output: OrganizationSchema })
  current() {
    return this.service.current();
  }

  @Query({ output: z.array(OrganizationSchema) })
  list() {
    return this.service.listMine();
  }
}
