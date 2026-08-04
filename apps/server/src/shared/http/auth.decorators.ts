import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const IS_PUBLIC_KEY = 'agentforge:public';
/** Marks a route as reachable without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthUser {
  userId: string;
  via: 'session' | 'pat';
  sessionId?: string;
}

export interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.authUser) throw new Error('CurrentUser used on an unauthenticated route');
  return req.authUser;
});
