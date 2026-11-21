import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ActivityModule } from '../activity/activity.module';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectAssistantController } from './project-assistant.controller';

/**
 * Wires the streaming AI project assistant.
 *
 * There is no AI module to register: the controller calls the AI SDK itself
 * until the app moves to NestJS 12 and the official `@nestjs/ai`. The imported
 * feature modules provide the tenant-scoped project reader, the activity-feed
 * reader, and the `AuthGuard` the controller depends on.
 */
@Module({
  imports: [AuthModule, ProjectsModule, ActivityModule],
  controllers: [ProjectAssistantController],
})
export class AssistantModule {}
