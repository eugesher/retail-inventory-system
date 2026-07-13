import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '@retail-inventory-system/auth';
import { SystemHealthView } from '@retail-inventory-system/contracts';

import { CheckHealthUseCase } from '../application/use-cases';

// `GET /api/health` — the system's liveness report (ADR-044).
//
// `@Public()`: a monitor has no JWT, and a health endpoint that can fail on authentication
// cannot tell you whether the system is alive. It leaks nothing — service names are already
// public knowledge from the README, and the payload carries no data.
//
// Always **200**, whether the verdict is `ok` or `degraded`. This is a *report about the
// system*, not the gateway's own liveness signal: returning 503 because notification is down
// would make the gateway look dead when it is the one thing provably alive. A monitor reads
// `status`, not the HTTP code.
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly checkHealth: CheckHealthUseCase) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness of every deployable, probed over RabbitMQ' })
  @ApiOkResponse({ type: SystemHealthView })
  public check(): Promise<SystemHealthView> {
    return this.checkHealth.execute();
  }
}
