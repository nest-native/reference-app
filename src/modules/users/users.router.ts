import { Inject, NotFoundException, UseGuards } from '@nestjs/common';
import { Input, Mutation, Query, Router, TrpcContext } from 'nest-trpc-native';
import { z } from 'zod';
import type { AuthContext } from '../../auth/auth-context';
import { AuthGuard } from '../../auth/auth.guard';
import { OrganizationOnboardingService } from '../onboarding/organization-onboarding.service';
import { UsersService } from './users.service';

const UserViewSchema = z.object({
  id: z.number(),
  email: z.string(),
  createdAt: z.string(),
});

const OrgMemberSchema = z.object({
  id: z.number(),
  email: z.string(),
  role: z.string(),
  joinedAt: z.string(),
});

const InviteUserInputSchema = z.object({
  email: z.string().email(),
  projectName: z.string().min(1).max(120),
  initialPassword: z.string().min(8).max(128),
  role: z.enum(['admin', 'member', 'viewer']).optional(),
});

const InviteUserOutputSchema = z.object({
  user: z.object({ id: z.number(), email: z.string() }),
  membership: z.object({ id: z.number(), role: z.string() }),
  project: z.object({ id: z.number(), name: z.string() }),
  outboxEventId: z.string(),
});

@Router('users')
@UseGuards(AuthGuard)
export class UsersRouter {
  constructor(
    @Inject(UsersService) private readonly service: UsersService,
    @Inject(OrganizationOnboardingService)
    private readonly onboarding: OrganizationOnboardingService,
  ) {}

  @Query({ output: UserViewSchema })
  me() {
    return this.service.me();
  }

  @Query({ output: z.array(OrgMemberSchema) })
  list() {
    return this.service.listInCurrentOrg();
  }

  @Mutation({ input: InviteUserInputSchema, output: InviteUserOutputSchema })
  async invite(
    @Input() input: z.infer<typeof InviteUserInputSchema>,
    @TrpcContext('authContext') authContext: AuthContext,
  ) {
    if (!authContext.organization) {
      throw new NotFoundException('No active organization for this session');
    }
    const result = await this.onboarding.inviteUser({
      orgId: authContext.organization.id,
      invitedByUserId: authContext.user.id,
      email: input.email,
      projectName: input.projectName,
      initialPassword: input.initialPassword,
      role: input.role,
    });
    return {
      user: { id: result.user.id, email: result.user.email },
      membership: { id: result.membership.id, role: result.membership.role },
      project: { id: result.project.id, name: result.project.name },
      outboxEventId: result.outboxEventId,
    };
  }
}
