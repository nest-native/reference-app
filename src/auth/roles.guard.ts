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
 * Authorization for mutations, composed AFTER AuthGuard: authentication proves
 * WHO is calling, this proves WHAT they may do. The JWT carries the active
 * organization but no role — the role is re-read from the database on every
 * guarded request, so revoking a membership takes effect on the next mutation
 * instead of at token expiry. Procedures without @Roles are untouched (reads
 * stay token-trusted).
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
    if (!allowed?.length) return true;

    const auth = readAuthContext(context);
    if (!auth?.organization) {
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
    if (!allowed.includes(membership.role)) {
      throw new ForbiddenException(
        `Requires role ${allowed.join(' or ')}; you are ${membership.role}`,
      );
    }
    return true;
  }
}
