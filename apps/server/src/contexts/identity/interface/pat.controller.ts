import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  createPatRequestSchema,
  type CreatePatRequest,
  type PatDto,
} from '@agentforge/core';
import { CurrentUser, type AuthUser } from '../../../shared/http/auth.decorators';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import type { PersonalAccessToken } from '../domain/user';
import { AuthService } from '../application/auth.service';

function toDto(pat: PersonalAccessToken): PatDto {
  return {
    id: pat.id,
    name: pat.name,
    createdAt: pat.createdAt.toISOString(),
    lastUsedAt: pat.lastUsedAt?.toISOString() ?? null,
    revokedAt: pat.revokedAt?.toISOString() ?? null,
  };
}

@Controller('pats')
export class PatController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<PatDto[]> {
    return (await this.auth.listPats(user.userId)).map(toDto);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createPatRequestSchema)) body: CreatePatRequest,
  ): Promise<PatDto & { token: string }> {
    const { pat, raw } = await this.auth.createPat(user.userId, body.name);
    // The raw token is returned exactly once.
    return { ...toDto(pat), token: raw };
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.auth.revokePat(user.userId, id);
  }
}
