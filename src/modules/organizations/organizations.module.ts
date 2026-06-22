import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsRouter } from './organizations.router';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [
    DrizzleModule.forFeature([OrganizationsRepository]),
    AuthModule,
    RequestContextModule,
  ],
  providers: [OrganizationsService, OrganizationsRouter],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
