import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { ProjectsRepository } from '../projects/projects.repository';
import { TasksRepository } from './tasks.repository';
import { TasksRouter } from './tasks.router';
import { TasksService } from './tasks.service';

// Mirrors ProjectsModule. The transactional OutboxProducer the service injects
// comes from the global MessagingModule, so no messaging wiring lives here.
// ProjectsRepository is one of the tenancy predicates the service checks
// in-transaction (the task's project must belong to the caller's org); the
// other — MembershipsRepository, for the assignee — arrives with AuthModule.
@Module({
  imports: [
    DrizzleModule.forFeature([TasksRepository, ProjectsRepository]),
    AuthModule,
    RequestContextModule,
  ],
  providers: [TasksService, TasksRouter],
  exports: [TasksService],
})
export class TasksModule {}
