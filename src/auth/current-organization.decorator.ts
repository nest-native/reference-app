import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedRequest,
  CurrentOrganizationContext,
} from './auth-context';

// HTTP controllers only. tRPC procedures should use @TrpcContext('authContext')
// — nest-trpc-native resolves only its own @Input/@TrpcContext param decorators.
export const CurrentOrganization = createParamDecorator(
  (
    _data,
    context: ExecutionContext,
  ): CurrentOrganizationContext | null | undefined => {
    const req = context.switchToHttp().getRequest<
      AuthenticatedRequest | undefined
    >();
    return req?.authContext?.organization;
  },
);
