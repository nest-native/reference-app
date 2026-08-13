import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import { TasksRepository } from './tasks.repository';
import { TasksRouter } from './tasks.router';
import { TasksService } from './tasks.service';

// Mirrors ProjectsModule. The transactional OutboxProducer the service injects
// comes from the global MessagingModule, so no messaging wiring lives here.
// The projects/memberships repositories are the tenancy predicates the service
// checks in-transaction (owning project, org member assignee) and the ones
// RolesGuard reads — repositories are stateless, so a second forFeature
// registration is the same pattern OnboardingModule uses.
@Module({
  imports: [
    DrizzleModule.forFeature([
      TasksRepository,
      ProjectsRepository,
      MembershipsRepository,
    ]),
    AuthModule,
    RequestContextModule,
  ],
  providers: [TasksService, TasksRouter],
  exports: [TasksService],
})
export class TasksModule {}
