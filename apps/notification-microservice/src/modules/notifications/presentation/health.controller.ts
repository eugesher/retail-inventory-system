import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';

import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

export interface INotificationHealthResponse {
  status: 'ok';
  service: 'notification-microservice';
}

// RMQ-only service (ADR-011 §6); the liveness probe rides the same transport
// as the event subscribers — there is no HTTP listener to hit.
@Controller()
export class HealthController {
  @MessagePattern(ROUTING_KEYS.NOTIFICATION_HEALTH_PING)
  public ping(): INotificationHealthResponse {
    return { status: 'ok', service: 'notification-microservice' };
  }
}
