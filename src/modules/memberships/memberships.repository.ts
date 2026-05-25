import { Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { DrizzleRepository } from 'nest-drizzle-native';
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
