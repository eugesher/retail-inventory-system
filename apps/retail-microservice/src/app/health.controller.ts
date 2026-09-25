import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';

import { AppNameEnum, IHealthPingResult } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

@Controller()
export class HealthController {
  @MessagePattern(ROUTING_KEYS.RETAIL_HEALTH_PING)
  public ping(): IHealthPingResult {
    return { status: 'ok', service: AppNameEnum.RETAIL_MICROSERVICE };
  }
}
