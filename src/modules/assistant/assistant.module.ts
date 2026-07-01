import { Module } from '@nestjs/common';
import { AiModule } from '@nest-native/ai-sdk';
import { AuthModule } from '../../auth/auth.module';
import { ActivityModule } from '../activity/activity.module';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectAssistantController } from './project-assistant.controller';

/**
 * Wires the streaming AI project assistant.
 *
 * `AiModule.forRoot` registers the global `@AiStream` configuration (here, a
 * `defaultHeaders` marker applied to every streaming response); the decorator
 * itself binds the streaming interceptor per-route. The imported feature
 * modules provide the tenant-scoped project reader, the activity-feed reader,
 * and the `AuthGuard` the controller depends on.
 */
@Module({
  imports: [
    AiModule.forRoot({ defaultHeaders: { 'x-powered-by': 'nest-native-ai' } }),
    AuthModule,
    ProjectsModule,
    ActivityModule,
  ],
  controllers: [ProjectAssistantController],
})
export class AssistantModule {}
