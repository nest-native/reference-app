import { Inject, UseGuards } from '@nestjs/common';
import { Input, Mutation, Query, Router, TrpcContext } from 'nest-trpc-native';
import { z } from 'zod';
import type { AuthContext } from './auth-context';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LoginOutputSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: z.object({ id: z.number(), email: z.string() }),
  organization: z.object({ id: z.number() }).nullable(),
});

const MeOutputSchema = z.object({
  user: z.object({ id: z.number() }),
  organization: z.object({ id: z.number() }).nullable(),
});

@Router('auth')
export class AuthRouter {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Mutation({ input: LoginInputSchema, output: LoginOutputSchema })
  login(@Input() input: z.infer<typeof LoginInputSchema>) {
    return this.auth.login(input);
  }

  @Query({ output: MeOutputSchema })
  @UseGuards(AuthGuard)
  me(@TrpcContext('authContext') authContext: AuthContext) {
    return {
      user: { id: authContext.user.id },
      organization: authContext.organization,
    };
  }
}
