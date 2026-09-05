import { Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { and, eq } from 'drizzle-orm';
import { DrizzleRepository } from '@nest-native/drizzle';
import type { AppDatabase } from '../../database/database';
import {
  type Membership,
  type MembershipRole,
  memberships,
} from '../../database/schema';

export interface CreateMembershipInput {
  orgId: number;
  userId: number;
  role: MembershipRole;
}

@Injectable()
@DrizzleRepository()
export class MembershipsRepository {
  constructor(@InjectTransaction() private readonly db: AppDatabase) {}

  // The tenancy predicate: "is this user a member of this org, and as what?".
  // RolesGuard calls it on every mutation (outside any transaction, so the
  // @InjectTransaction proxy falls back to the base connection) and TasksService
  // calls it inside its transaction to validate an assignee.
  findByOrgAndUser(orgId: number, userId: number): Membership | undefined {
    return this.db
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)),
      )
      .get();
  }

  create(input: CreateMembershipInput): Membership {
    return this.db
      .insert(memberships)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }
}
