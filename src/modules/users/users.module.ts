import { Module } from '@nestjs/common';
import { DrizzleModule } from 'nest-drizzle-native';
import { AuthModule } from '../../auth/auth.module';
import { RequestContextModule } from '../../context/request-context.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { UsersRepository } from './users.repository';
import { UsersRouter } from './users.router';
import { UsersService } from './users.service';

@Module({
  imports: [
    DrizzleModule.forFeature([UsersRepository]),
    AuthModule,
    RequestContextModule,
    OnboardingModule,
  ],
  providers: [UsersService, UsersRouter],
  exports: [UsersService],
})
export class UsersModule {}
