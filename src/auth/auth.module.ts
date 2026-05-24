import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { loadEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { AuthGuard } from './auth.guard';
import { AuthMiddleware } from './auth.middleware';
import { AuthRouter } from './auth.router';
import { AuthService } from './auth.service';

@Module({
  imports: [DatabaseModule],
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
    AuthRouter,
  ],
  exports: [AuthService, AuthGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
