import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health(): { status: string } {
    // Expanded in Phase 3 with PG/Redis/worker-heartbeat/queue-depth checks.
    return { status: 'ok' };
  }
}
