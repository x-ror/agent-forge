import { Module } from '@nestjs/common';
import { DefaultBranchProbe } from './application/default-branch-probe';
import { GIT_PORT } from './domain/ports';
import { GitCli } from './infrastructure/git-cli';

/**
 * Leaf slice of the Scm context: read-only remote probing, no repositories and
 * no workspaces volume. Split out so ProjectsModule can use it — ScmModule
 * imports ProjectsModule, so the full module would be a cycle.
 */
@Module({
  providers: [DefaultBranchProbe, { provide: GIT_PORT, useClass: GitCli }],
  exports: [DefaultBranchProbe],
})
export class ScmProbeModule {}
