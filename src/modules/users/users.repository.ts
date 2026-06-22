import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DrizzleRepository, InjectDrizzle } from '@nest-native/drizzle';
import type { AppDatabase } from '../../database/database';
import { type User, memberships, users } from '../../database/schema';

export interface OrgMember {
  id: number;
  email: string;
  role: string;
  joinedAt: string;
}

@Injectable()
@DrizzleRepository()
export class UsersRepository {
  constructor(@InjectDrizzle() private readonly db: AppDatabase) {}

  findById(id: number): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  listMembersInOrg(orgId: number): OrgMember[] {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(desc(memberships.createdAt))
      .all();
  }
}
