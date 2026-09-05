import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '../database/schema';
import { MembershipsRepository } from '../modules/memberships/memberships.repository';
import { readAuthContext } from './auth-context';
import { ROLES_METADATA } from './roles.decorator';

/**
 * Authorization, composed AFTER AuthGuard: authentication proves WHO is
 * calling, this proves WHAT they may do. The JWT snapshots the active
 * organization but no role, so every guarded request re-reads the caller's
 * membership from the database:
 *
 * - no membership in the token's organization → refused, reads included. The
 *   token outlives a revocation by up to AUTH_TTL_SECONDS, and a tenant's
 *   member roster, project list, activity feed and AI digests are exactly what
 *   an offboarded account should stop seeing first.
 * - `@Roles(...)` narrows a procedure further to specific roles; without it,
 *   holding any live membership is enough.
 *
 * The cost is one indexed lookup per request — authorization is deliberately
 * not cached, since a stale allow is the whole problem being fixed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MembershipsRepository)
    private readonly memberships: MembershipsRepository,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<MembershipRole[]>(
      ROLES_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const auth = readAuthContext(context);
    if (!auth?.organization) {
      // Nothing tenant-scoped to authorize — a user with no membership can
      // still read their own profile. A procedure that names roles has no role
      // to compare, so it still refuses.
      if (!allowed?.length) return true;
      throw new ForbiddenException('No active organization for this session');
    }
    const membership = this.memberships.findByOrgAndUser(
      auth.organization.id,
      auth.user.id,
    );
    if (!membership) {
      throw new ForbiddenException(
        'You are no longer a member of this organization',
      );
    }
    if (allowed?.length && !allowed.includes(membership.role)) {
      throw new ForbiddenException(
        `Requires role ${allowed.join(' or ')}; you are ${membership.role}`,
      );
    }
    return true;
  }
}
