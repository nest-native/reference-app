import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  CurrentOrganizationContext,
  CurrentUserContext,
} from '../../auth/auth-context';
import {
  CURRENT_ORGANIZATION,
  CURRENT_USER,
} from '../../context/request-context.module';
import { type OrgMember, UsersRepository } from './users.repository';

export interface UserView {
  id: number;
  email: string;
  createdAt: string;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository) private readonly repo: UsersRepository,
    @Inject(CURRENT_USER) private readonly currentUser: CurrentUserContext | null,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
  ) {}

  me(): UserView {
    if (!this.currentUser) throw new UnauthorizedException();
    const found = this.repo.findById(this.currentUser.id);
    if (!found) throw new NotFoundException('User no longer exists');
    return { id: found.id, email: found.email, createdAt: found.createdAt };
  }

  listInCurrentOrg(): OrgMember[] {
    if (!this.currentOrg) {
      throw new NotFoundException('No active organization for this session');
    }
    return this.repo.listMembersInOrg(this.currentOrg.id);
  }
}
