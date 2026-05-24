import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DrizzleRepository, InjectDrizzle } from 'nest-drizzle-native';
import type { AppDatabase } from '../../database/database';
import { type Project, projects } from '../../database/schema';

export interface CreateProjectInput {
  orgId: number;
  name: string;
  createdBy: number;
}

@Injectable()
@DrizzleRepository()
export class ProjectsRepository {
  constructor(@InjectDrizzle() private readonly db: AppDatabase) {}

  listForOrg(orgId: number): Project[] {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.orgId, orgId))
      .orderBy(desc(projects.id))
      .all();
  }

  findByIdInOrg(id: number, orgId: number): Project | undefined {
    return this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.orgId, orgId)))
      .get();
  }

  create(input: CreateProjectInput): Project {
    return this.db
      .insert(projects)
      .values({
        orgId: input.orgId,
        name: input.name,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }
}
