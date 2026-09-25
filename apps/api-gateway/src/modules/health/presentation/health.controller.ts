import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '@retail-inventory-system/auth';
import { SystemHealthView } from '@retail-inventory-system/contracts';

import { CheckHealthUseCase } from '../application/use-cases';

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
