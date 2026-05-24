import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth-context';
import { AuthService } from './auth.service';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  use(req: AuthenticatedRequest, _res: unknown, next: () => void): void {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      next();
      return;
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    try {
      req.authContext = this.auth.resolve(token);
    } catch {
      // Invalid token: leave req.authContext unset; AuthGuard will reject.
    }
    next();
  }
}
