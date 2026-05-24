import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle } from 'nest-drizzle-native';
import type { AppDatabase } from '../database/database';
import { memberships, users } from '../database/schema';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import type { AuthContext } from './auth-context';
import { type JwtPayload, signJwt, verifyJwt } from './jwt';
import { verifyPassword } from './password';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: { id: number; email: string };
  organization: { id: number } | null;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDrizzle() private readonly db: AppDatabase,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  login(input: LoginInput): LoginResult {
    const user = this.db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .get();
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const membership = this.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .get();
    const orgId = membership?.orgId ?? null;

    const token = signJwt(
      { sub: user.id, org: orgId },
      this.config.secret,
      this.config.ttlSeconds,
    );
    const expiresAt = new Date(
      (Math.floor(Date.now() / 1000) + this.config.ttlSeconds) * 1000,
    ).toISOString();

    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email },
      organization: orgId === null ? null : { id: orgId },
    };
  }

  resolve(token: string): AuthContext {
    const payload: JwtPayload = verifyJwt(token, this.config.secret);
    return {
      user: { id: payload.sub },
      organization: payload.org === null ? null : { id: payload.org },
    };
  }
}
