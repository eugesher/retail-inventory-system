import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';

import { AppNameEnum, IHealthPingResult } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

// The service's liveness probe (ADR-044), answered on its existing `retail_queue` RPC queue —
// this is an RMQ-only deployable, so there is no HTTP port to hit. The gateway fans all five
// of these out behind `GET /api/health`.
//
// It lives in `app/`, not in a module, because liveness is a property of the **deployable**,
// not of any bounded context inside it. Retail makes that plain: it holds three modules, and
// "which module owns the service's health?" has no answer. (`app/filters/` in the gateway is
// the same idea — an app-level concern outside the hexagon.)
//
// The handler does NO I/O on purpose. It proves a Nest app is consuming this queue and
// nothing more; see `IHealthPingResult` for why a DB round-trip here would be a mistake.
@Controller()
export class HealthController {
  @MessagePattern(ROUTING_KEYS.RETAIL_HEALTH_PING)
  public ping(): IHealthPingResult {
    return { status: 'ok', service: AppNameEnum.RETAIL_MICROSERVICE };
  }
}
