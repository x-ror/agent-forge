import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, type AuthedRequest } from '../../../shared/http/auth.decorators';
import { parseCookies, SESSION_COOKIE } from '../../../shared/http/cookies';
import { AuthService } from '../application/auth.service';

/** Session cookie or Bearer PAT (§9). Applied globally; opt out with @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const sessionToken = parseCookies(req)[SESSION_COOKIE];
    if (sessionToken) {
      const result = await this.auth.validateSession(sessionToken);
      if (result) {
        req.authUser = { userId: result.user.id, via: 'session', sessionId: result.sessionId };
        return true;
      }
    }

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const user = await this.auth.validatePat(header.slice('Bearer '.length).trim());
      if (user) {
        req.authUser = { userId: user.id, via: 'pat' };
        return true;
      }
    }

    throw new UnauthorizedException('authentication required');
  }
}
