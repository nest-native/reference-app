import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle } from '@nest-native/drizzle';
import { LockoutService } from '@nest-native/lockout';
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
    // Explicit token like every other provider here: esbuild/tsx doesn't emit
    // `design:paramtypes`, so this app never relies on type-based DI.
    @Inject(LockoutService) private readonly lockout: LockoutService,
  ) {}

  async login(
    input: LoginInput,
    ip: string | undefined,
  ): Promise<LoginResult> {
    // Lock by email OR source IP. `email` is a custom identity dimension; the IP
    // comes from the tRPC context (see trpc.module.ts) — do NOT trust proxy
    // headers unless the platform's `trust proxy` is configured for them.
    const identity = { email: input.email, ip };

    // Pre-auth gate: reject a locked identity before touching the credential.
    const gate = await this.lockout.check(identity);
    if (gate.locked) {
      // @nest-native/trpc maps this HttpException to a TRPCError('TOO_MANY_REQUESTS').
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Too many failed login attempts. Try again later.',
          retryAfterMs: gate.retryAfterMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = this.db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .get();
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      await this.lockout.reportFailure(identity);
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.lockout.reportSuccess(identity);

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
