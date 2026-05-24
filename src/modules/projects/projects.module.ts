import { Module } from '@nestjs/common';
import { DrizzleModule } from 'nest-drizzle-native';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { ProjectsRepository } from './projects.repository';
import { ProjectsRouter } from './projects.router';
import { ProjectsService } from './projects.service';

@Module({
  imports: [
    DrizzleModule.forFeature([ProjectsRepository]),
    AuthModule,
    RequestContextModule,
  ],
  providers: [ProjectsService, ProjectsRouter],
  exports: [ProjectsService],
})
export class ProjectsModule {}
