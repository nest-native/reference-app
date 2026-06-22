import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DrizzleRepository, InjectDrizzle } from '@nest-native/drizzle';
import type { AppDatabase } from '../../database/database';
import {
  type Organization,
  memberships,
  organizations,
} from '../../database/schema';

@Injectable()
@DrizzleRepository()
export class OrganizationsRepository {
  constructor(@InjectDrizzle() private readonly db: AppDatabase) {}

  findById(id: number): Organization | undefined {
    return this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .get();
  }

  listForUser(userId: number): Organization[] {
    return this.db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, userId))
      .all();
  }
}
