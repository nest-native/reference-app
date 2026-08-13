import { SetMetadata } from '@nestjs/common';
import type { MembershipRole } from '../database/schema';

export const ROLES_METADATA = 'reference-app:roles';

/**
 * Declares which membership roles may run a procedure. Read by `RolesGuard`,
 * which resolves the caller's CURRENT role from the database — the token only
 * says which organization is active, never what the caller may do in it.
 */
export const Roles = (...roles: MembershipRole[]) =>
  SetMetadata(ROLES_METADATA, roles);
