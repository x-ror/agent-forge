import { Module } from '@nestjs/common';
import { executionRepositoryProviders } from '../execution/execution.module';
import { ProjectsModule } from '../projects/projects.module';
import { ScmService } from './application/scm.service';
import { GH_CLI_PORT, GIT_PORT, GITHUB_PORT } from './domain/ports';
import { GhCli } from './infrastructure/gh-cli';
import { GitCli } from './infrastructure/git-cli';
import { GithubClient } from './infrastructure/github-client';

@Module({
  imports: [ProjectsModule],
  providers: [
    ScmService,
    { provide: GIT_PORT, useClass: GitCli },
    { provide: GITHUB_PORT, useClass: GithubClient },
    { provide: GH_CLI_PORT, useClass: GhCli },
    ...executionRepositoryProviders,
  ],
  exports: [ScmService, GIT_PORT, GITHUB_PORT],
})
export class ScmModule {}
