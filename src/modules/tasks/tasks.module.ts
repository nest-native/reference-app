import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { TasksRepository } from './tasks.repository';
import { TasksRouter } from './tasks.router';
import { TasksService } from './tasks.service';

// Mirrors ProjectsModule. The transactional OutboxProducer the service injects
// comes from the global MessagingModule, so no messaging wiring lives here.
@Module({
  imports: [
    DrizzleModule.forFeature([TasksRepository]),
    AuthModule,
    RequestContextModule,
  ],
  providers: [TasksService, TasksRouter],
  exports: [TasksService],
})
export class TasksModule {}
