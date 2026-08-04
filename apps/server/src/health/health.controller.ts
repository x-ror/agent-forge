import { Controller, Get } from '@nestjs/common';
import { Public } from '../shared/http/auth.decorators';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health(): { status: string } {
    // Expanded in Phase 3 with PG/Redis/worker-heartbeat/queue-depth checks.
    return { status: 'ok' };
  }
}
