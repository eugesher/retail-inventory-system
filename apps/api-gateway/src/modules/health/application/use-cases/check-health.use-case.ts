import { Inject, Injectable } from '@nestjs/common';

import { SystemHealthView } from '@retail-inventory-system/contracts';

import { HEALTH_GATEWAY_PORT, IHealthGatewayPort } from '../ports';

// Check Health (ADR-044): fan the liveness probe out to every RMQ deployable and roll the
// five answers into one verdict.
//
// The roll-up is the only judgement here, and it is deliberately harsh: `ok` requires ALL
// five to answer `ok`. Anything else is `degraded` — a system missing its event store is not
// healthy just because four of five services are. There is no `down` status: the gateway
// replying at all proves the gateway is up, and it does not speak for the whole system's
// death.
//
// No logging. A health endpoint is polled on a schedule, and a log line per poll is noise
// that buries the events that matter.
@Injectable()
export class CheckHealthUseCase {
  constructor(
    @Inject(HEALTH_GATEWAY_PORT)
    private readonly gateway: IHealthGatewayPort,
  ) {}

  public async execute(): Promise<SystemHealthView> {
    const services = await this.gateway.probeAll();
    const allOk = Object.values(services).every((service) => service.status === 'ok');

    return { status: allOk ? 'ok' : 'degraded', services };
  }
}
