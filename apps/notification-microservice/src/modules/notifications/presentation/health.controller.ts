import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';

import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

export interface INotificationHealthResponse {
  status: 'ok';
  service: 'notification-microservice';
}

// The notification microservice is RMQ-only — there is no HTTP surface, so
// the health check is exposed through the same RabbitMQ transport. The
// gateway can proxy a `GET /health/notification` to this pattern later.
@Controller()
export class HealthController {
  @MessagePattern(ROUTING_KEYS.NOTIFICATION_HEALTH_PING)
  public ping(): INotificationHealthResponse {
    return { status: 'ok', service: 'notification-microservice' };
  }
}
