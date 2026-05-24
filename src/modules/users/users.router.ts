import { Inject, UseGuards } from '@nestjs/common';
import { Query, Router } from 'nest-trpc-native';
import { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard';
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

@Router('users')
@UseGuards(AuthGuard)
export class UsersRouter {
  constructor(
    @Inject(UsersService) private readonly service: UsersService,
  ) {}

  @Query({ output: UserViewSchema })
  me() {
    return this.service.me();
  }

  @Query({ output: z.array(OrgMemberSchema) })
  list() {
    return this.service.listInCurrentOrg();
  }
}
