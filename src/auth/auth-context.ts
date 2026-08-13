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
 *
 * It BRANCHES on the transport rather than trying one then the other, because
 * `switchToHttp().getRequest()` is just `getArgs()[0]` whatever the transport
 * is — under tRPC that argument is the caller's own INPUT, so a fallback would
 * read authentication out of the request body. Zod strips unknown keys, so no
 * procedure here can be forged today; a single `.passthrough()` schema is all
 * it would take, and an auth extractor must not depend on that.
 */
export function readAuthContext(
  context: ExecutionContext,
): AuthContext | undefined {
  if (context.getType() === 'http') {
    const req = context.switchToHttp().getRequest<
      AuthenticatedRequest | undefined
    >();
    return req?.authContext;
  }
  const trpcCtx = context.getArgs()[1] as
    | { authContext?: AuthContext }
    | undefined;
  return trpcCtx?.authContext;
}
