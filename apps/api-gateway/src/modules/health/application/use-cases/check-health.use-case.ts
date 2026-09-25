import { Inject, Injectable } from '@nestjs/common';

import { SystemHealthView } from '@retail-inventory-system/contracts';

import { HEALTH_GATEWAY_PORT, IHealthGatewayPort } from '../ports';

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
