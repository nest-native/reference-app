import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { loadEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { MembershipsModule } from '../modules/memberships/memberships.module';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { AuthGuard } from './auth.guard';
import { AuthMiddleware } from './auth.middleware';
import { AuthRouter } from './auth.router';
import { AuthService } from './auth.service';
import { AppLockoutModule } from './lockout.setup';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    DatabaseModule,
    AppLockoutModule,
    // RolesGuard re-reads the caller's membership on every guarded request, so
    // the repository is re-exported below: the guard's dependency travels with
    // the guard into every module that imports AuthModule.
    MembershipsModule,
  ],
  providers: [
    {
      provide: AUTH_CONFIG,
      useFactory: (): AuthConfig => {
        const env = loadEnv();
        return { secret: env.authSecret, ttlSeconds: env.authTtlSeconds };
      },
    },
    AuthService,
    AuthGuard,
    RolesGuard,
    AuthRouter,
  ],
  exports: [AuthService, AuthGuard, RolesGuard, MembershipsModule],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
