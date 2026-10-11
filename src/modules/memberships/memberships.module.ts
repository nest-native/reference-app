import { Module } from '@nestjs/common';
import { MembershipsRepository } from './memberships.repository';

// ONE registration of the tenancy predicate for the whole app: RolesGuard reads
// it on every guarded request, TasksService validates assignees with it, and
// onboarding writes memberships through it.
@Module({
  providers: [MembershipsRepository],
  exports: [MembershipsRepository],
})
export class MembershipsModule {}
