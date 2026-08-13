import type { ExecutionContext } from '@nestjs/common';

export interface CurrentUserContext {
  id: number;
  email?: string;
}

export interface CurrentOrganizationContext {
  id: number;
  slug?: string;
}

export interface AuthContext {
  user: CurrentUserContext;
  organization: CurrentOrganizationContext | null;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Connection address (populated by the HTTP platform). NOT a proxy header. */
  ip?: string;
  socket?: { remoteAddress?: string };
  authContext?: AuthContext;
}

/**
 * One extractor for both transports: tRPC passes its context object as the
 * second handler argument (`getArgs()[1]`), Express carries it on the request.
 * Shared by AuthGuard and RolesGuard so they never disagree about the caller.
 */
export function readAuthContext(
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
