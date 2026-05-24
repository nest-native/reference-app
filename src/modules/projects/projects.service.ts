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
import type { Project } from '../../database/schema';
import { ProjectsRepository } from './projects.repository';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(ProjectsRepository) private readonly repo: ProjectsRepository,
    @Inject(CURRENT_USER)
    private readonly currentUser: CurrentUserContext | null,
    @Inject(CURRENT_ORGANIZATION)
    private readonly currentOrg: CurrentOrganizationContext | null,
  ) {}

  list(): Project[] {
    const org = this.requireOrg();
    return this.repo.listForOrg(org.id);
  }

  get(id: number): Project {
    const org = this.requireOrg();
    const project = this.repo.findByIdInOrg(id, org.id);
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return project;
  }

  create(input: { name: string }): Project {
    const org = this.requireOrg();
    const user = this.requireUser();
    return this.repo.create({
      orgId: org.id,
      name: input.name,
      createdBy: user.id,
    });
  }

  private requireOrg(): CurrentOrganizationContext {
    if (!this.currentOrg) {
      throw new NotFoundException('No active organization for this session');
    }
    return this.currentOrg;
  }

  private requireUser(): CurrentUserContext {
    if (!this.currentUser) throw new UnauthorizedException();
    return this.currentUser;
  }
}
