import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './application/auth.service';
import { PASSWORD_HASHER } from './domain/password-hasher';
import { PAT_REPOSITORY, SESSION_REPOSITORY, USER_REPOSITORY } from './domain/repositories';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import {
  TypeormPersonalAccessTokenRepository,
  TypeormSessionRepository,
  TypeormUserRepository,
} from './infrastructure/typeorm-repositories';
import { AuthController } from './interface/auth.controller';
import { AuthGuard } from './interface/auth.guard';
import { PatController } from './interface/pat.controller';

@Module({
  controllers: [AuthController, PatController],
  providers: [
    AuthService,
    { provide: USER_REPOSITORY, useClass: TypeormUserRepository },
    { provide: SESSION_REPOSITORY, useClass: TypeormSessionRepository },
    { provide: PAT_REPOSITORY, useClass: TypeormPersonalAccessTokenRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, USER_REPOSITORY],
})
export class IdentityModule {}
