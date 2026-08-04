import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginRequestSchema, registerRequestSchema, type LoginRequest, type RegisterRequest, type UserDto } from '@agentforge/core';
import { CurrentUser, Public, type AuthUser } from '../../../shared/http/auth.decorators';
import { clearSessionCookie, parseCookies, SESSION_COOKIE, setSessionCookie } from '../../../shared/http/cookies';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import type { User } from '../domain/user';
import { AuthService, SESSION_TTL_SECONDS } from '../application/auth.service';

function toUserDto(user: User): UserDto {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest, @Res({ passthrough: true }) res: Response): Promise<UserDto> {
    const { user, sessionToken } = await this.auth.register(body.email, body.password);
    setSessionCookie(res, sessionToken, SESSION_TTL_SECONDS);
    return toUserDto(user);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest, @Res({ passthrough: true }) res: Response): Promise<UserDto> {
    const { user, sessionToken } = await this.auth.login(body.email, body.password);
    setSessionCookie(res, sessionToken, SESSION_TTL_SECONDS);
    return toUserDto(user);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    clearSessionCookie(res);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<{ userId: string; via: string }> {
    return { userId: user.userId, via: user.via };
  }
}
