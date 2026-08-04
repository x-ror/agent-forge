import { Module } from '@nestjs/common';
import { SecretBoxService } from '../../shared/crypto/secret-box';
import { ScmProbeModule } from '../scm/scm-probe.module';
import { ProjectsService, SecretProvisioningService } from './application/projects.service';
import { PROJECT_REPOSITORY, SECRET_REPOSITORY } from './domain/repositories';
import { TypeormProjectRepository, TypeormSecretRepository } from './infrastructure/typeorm-repositories';
import { ProjectsController } from './interface/projects.controller';

@Module({
  imports: [ScmProbeModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    SecretProvisioningService,
    SecretBoxService,
    { provide: PROJECT_REPOSITORY, useClass: TypeormProjectRepository },
    { provide: SECRET_REPOSITORY, useClass: TypeormSecretRepository },
  ],
  exports: [ProjectsService, SecretProvisioningService, PROJECT_REPOSITORY],
})
export class ProjectsModule {}
