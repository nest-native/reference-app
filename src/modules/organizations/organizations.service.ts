import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CurrentOrganizationContext,
  CurrentUserContext,
} from '../../auth/auth-context';
import {
  CURRENT_ORGANIZATION,
  CURRENT_USER,
} from '../../context/request-context.module';
import type { Organization } from '../../database/schema';
import { OrganizationsRepository } from './organizations.repository';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(OrganizationsRepository)
    private readonly repo: OrganizationsRepository,
    @Inject(CURRENT_USER) private readonly currentUser: CurrentUserContext | null,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
  ) {}

  current(): Organization {
    if (!this.currentOrg) {
      throw new NotFoundException('No active organization for this session');
    }
    const found = this.repo.findById(this.currentOrg.id);
    if (!found) {
      throw new NotFoundException('Active organization no longer exists');
    }
    return found;
  }

  listMine(): Organization[] {
    if (!this.currentUser) return [];
    return this.repo.listForUser(this.currentUser.id);
  }
}
