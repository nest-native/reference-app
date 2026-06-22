import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, CurrentUserContext } from './auth-context';

// HTTP controllers only. tRPC procedures should use @TrpcContext('authContext')
// — @nest-native/trpc resolves only its own @Input/@TrpcContext param decorators.
export const CurrentUser = createParamDecorator(
  (_data, context: ExecutionContext): CurrentUserContext | undefined => {
    const req = context.switchToHttp().getRequest<
      AuthenticatedRequest | undefined
    >();
    return req?.authContext?.user;
  },
);
