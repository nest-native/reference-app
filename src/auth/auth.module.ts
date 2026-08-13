import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { DrizzleModule } from '@nest-native/drizzle';
import { loadEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { MembershipsRepository } from '../modules/memberships/memberships.repository';
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
    // RolesGuard re-reads the caller's membership on every guarded mutation.
    DrizzleModule.forFeature([MembershipsRepository]),
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
  exports: [AuthService, AuthGuard, RolesGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
