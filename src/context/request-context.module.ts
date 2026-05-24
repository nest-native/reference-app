import { Global, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type {
  AuthenticatedRequest,
  CurrentOrganizationContext,
  CurrentUserContext,
} from '../auth/auth-context';

export const CURRENT_USER = Symbol.for('reference-app:current-user');
export const CURRENT_ORGANIZATION = Symbol.for(
  'reference-app:current-organization',
);

@Global()
@Module({
  providers: [
    {
      provide: CURRENT_USER,
      scope: Scope.REQUEST,
      inject: [REQUEST],
      useFactory: (req: AuthenticatedRequest): CurrentUserContext | null =>
        req?.authContext?.user ?? null,
    },
    {
      provide: CURRENT_ORGANIZATION,
      scope: Scope.REQUEST,
      inject: [REQUEST],
      useFactory: (
        req: AuthenticatedRequest,
      ): CurrentOrganizationContext | null =>
        req?.authContext?.organization ?? null,
    },
  ],
  exports: [CURRENT_USER, CURRENT_ORGANIZATION],
})
export class RequestContextModule {}
