import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { readAuthContext } from './auth-context';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!readAuthContext(context)?.user) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
