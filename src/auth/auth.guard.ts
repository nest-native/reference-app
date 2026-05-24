import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthContext, AuthenticatedRequest } from './auth-context';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!this.extractAuthContext(context)?.user) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractAuthContext(
    context: ExecutionContext,
  ): AuthContext | undefined {
    const trpcCtx = context.getArgs()[1] as
      | { authContext?: AuthContext }
      | undefined;
    if (trpcCtx?.authContext) return trpcCtx.authContext;

    const req = context.switchToHttp().getRequest<
      AuthenticatedRequest | undefined
    >();
    return req?.authContext;
  }
}
