import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { UsersRepository } from './users.repository';
import { UsersRouter } from './users.router';
import { UsersService } from './users.service';

@Module({
  imports: [
    AuthModule,
    RequestContextModule,
    OnboardingModule,
  ],
  providers: [UsersRepository, UsersService, UsersRouter],
  exports: [UsersService],
})
export class UsersModule {}
