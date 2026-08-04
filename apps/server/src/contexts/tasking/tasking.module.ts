import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ScmModule } from '../scm/scm.module';
import { PubSubListener } from '../../shared/sse/pubsub-listener.service';
import { TaskSyncService } from './application/task-sync.service';
import { TasksService } from './application/tasks.service';
import { TASK_SOURCE_PROVIDERS } from './domain/ports';
import { TASK_REPOSITORY, TASK_SOURCE_REPOSITORY } from './domain/repositories';
import {
  FileTasksProvider,
  GithubIssuesProvider,
  JiraProvider,
} from './infrastructure/providers';
import {
  TypeormTaskRepository,
  TypeormTaskSourceRepository,
} from './infrastructure/typeorm-repositories';
import { TaskSourcesController, TasksController } from './interface/tasking.controller';

@Module({
  imports: [ProjectsModule, ScmModule],
  controllers: [TaskSourcesController, TasksController],
  providers: [
    TasksService,
    TaskSyncService,
    PubSubListener,
    GithubIssuesProvider,
    FileTasksProvider,
    JiraProvider,
    { provide: TASK_REPOSITORY, useClass: TypeormTaskRepository },
    { provide: TASK_SOURCE_REPOSITORY, useClass: TypeormTaskSourceRepository },
    {
      provide: TASK_SOURCE_PROVIDERS,
      inject: [GithubIssuesProvider, FileTasksProvider, JiraProvider],
      useFactory: (
        github: GithubIssuesProvider,
        file: FileTasksProvider,
        jira: JiraProvider,
      ) => [github, file, jira],
    },
  ],
  exports: [TasksService, TaskSyncService, TASK_REPOSITORY, TASK_SOURCE_REPOSITORY],
})
export class TaskingModule {}
