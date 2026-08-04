import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ScmModule } from '../scm/scm.module';
import { NotificationsService } from './application/notifications.service';

@Module({
  imports: [ProjectsModule, ScmModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
