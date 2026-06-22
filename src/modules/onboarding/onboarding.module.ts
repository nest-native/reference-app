import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { OutboxProducer } from '../outbox/outbox-producer.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { OrganizationOnboardingService } from './organization-onboarding.service';

// Onboarding only needs the transactional OUTBOX PRODUCER (the `enqueue` that
// writes the row in the business transaction) — it never touches the claimer or
// the transport. We provide OutboxProducer directly rather than importing the
// whole OutboxModule on purpose: importing the bare OutboxModule here would
// instantiate a SECOND OutboxClaimer bound to the in-process transport, and
// under the Kafka profile `app.get(OutboxClaimer)` could resolve that one
// instead of the Kafka-bound claimer wired in app.module — silently dispatching
// in-process instead of publishing to Kafka. OutboxProducer is a stateless
// `@InjectTransaction()` insert (CLS is global, DatabaseModule is imported), so a
// per-module provider is safe and shares the same DB the claimer drains.
@Module({
  imports: [
    DatabaseModule,
    DrizzleModule.forFeature([MembershipsRepository, ProjectsRepository]),
    AuditLogModule,
  ],
  providers: [OrganizationOnboardingService, OutboxProducer],
  exports: [OrganizationOnboardingService],
})
export class OnboardingModule {}
