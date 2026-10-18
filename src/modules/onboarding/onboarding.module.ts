import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { ProjectsRepository } from '../projects/projects.repository';
import { OrganizationOnboardingService } from './organization-onboarding.service';

// Onboarding only needs the outbox's PRODUCER side (`Outbox.add()`, which writes
// the message in the business transaction) — it never touches the relay or a
// transport. `OutboxModule` is global and exports a single `Outbox` (and a
// single relay), so the service injects it directly with no per-module wiring.
// The message goes through the app's SQLite store into the same database the
// relay drains.
@Module({
  imports: [
    DatabaseModule,
    MembershipsModule,
    AuditLogModule,
  ],
  providers: [ProjectsRepository, OrganizationOnboardingService],
  exports: [OrganizationOnboardingService],
})
export class OnboardingModule {}
