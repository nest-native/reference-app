import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { ProjectsRepository } from './projects.repository';
import { ProjectsRouter } from './projects.router';
import { ProjectsService } from './projects.service';

@Module({
  imports: [
    AuthModule,
    RequestContextModule,
  ],
  providers: [ProjectsRepository, ProjectsService, ProjectsRouter],
  exports: [ProjectsService],
})
export class ProjectsModule {}
