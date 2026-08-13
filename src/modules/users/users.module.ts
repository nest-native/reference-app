import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { MembershipsRepository } from '../memberships/memberships.repository';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { UsersRepository } from './users.repository';
import { UsersRouter } from './users.router';
import { UsersService } from './users.service';

@Module({
  imports: [
    // MembershipsRepository is here for RolesGuard on users.invite.
    DrizzleModule.forFeature([UsersRepository, MembershipsRepository]),
    AuthModule,
    RequestContextModule,
    OnboardingModule,
  ],
  providers: [UsersService, UsersRouter],
  exports: [UsersService],
})
export class UsersModule {}
