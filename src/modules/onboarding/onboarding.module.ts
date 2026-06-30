import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import { OrganizationOnboardingService } from './organization-onboarding.service';

// Onboarding only needs the transactional OUTBOX PRODUCER (the `enqueue` that
// writes the row in the business transaction) — it never touches the claimer or
// the transport. `MessagingModule` is global and exports a SINGLE `OutboxProducer`
// (and a single claimer), so the service injects it directly with no per-module
// wiring: there is no longer any risk of instantiating a second claimer (the
// hazard the old hand-rolled `OutboxModule` import had to work around). The
// producer is a stateless `@InjectTransaction()` insert that shares the same DB
// the claimer drains.
@Module({
  imports: [
    DatabaseModule,
    DrizzleModule.forFeature([MembershipsRepository, ProjectsRepository]),
    AuditLogModule,
  ],
  providers: [OrganizationOnboardingService],
  exports: [OrganizationOnboardingService],
})
export class OnboardingModule {}
