import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { MembershipsRepository } from './memberships.repository';

// ONE registration of the tenancy predicate for the whole app: RolesGuard reads
// it on every guarded request, TasksService validates assignees with it, and
// onboarding writes memberships through it.
//
// The `forFeature(...)` call is hoisted into a constant on purpose. It returns a
// FRESH dynamic module object each call and Nest 11 keys modules by object
// identity, so calling it twice — once for `imports`, once for `exports` —
// exports a module the container never instantiated.
const MembershipsFeature = DrizzleModule.forFeature([MembershipsRepository]);

@Module({
  imports: [MembershipsFeature],
  exports: [MembershipsFeature],
})
export class MembershipsModule {}
