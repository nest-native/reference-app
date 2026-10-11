import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsRouter } from './organizations.router';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [
    AuthModule,
    RequestContextModule,
  ],
  providers: [OrganizationsRepository, OrganizationsService, OrganizationsRouter],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
