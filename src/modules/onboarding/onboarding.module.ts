import { Module } from '@nestjs/common';
import { DrizzleModule } from 'nest-drizzle-native';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { OutboxModule } from '../outbox/outbox.module';
import { ProjectsRepository } from '../projects/projects.repository';
import { OrganizationOnboardingService } from './organization-onboarding.service';

@Module({
  imports: [
    DatabaseModule,
    DrizzleModule.forFeature([MembershipsRepository, ProjectsRepository]),
    AuditLogModule,
    OutboxModule,
  ],
  providers: [OrganizationOnboardingService],
  exports: [OrganizationOnboardingService],
})
export class OnboardingModule {}
