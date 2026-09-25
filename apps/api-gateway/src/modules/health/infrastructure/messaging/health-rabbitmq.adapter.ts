import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import {
  IHealthPingResult,
  MicroserviceClientTokenEnum,
  ServiceHealthView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { HEALTH_PROBE_TIMEOUT_MS, IHealthGatewayPort } from '../../application/ports';

interface IProbeTarget {
  name: string;
  client: ClientProxy;
  routingKey: string;
}

@Injectable()
export class HealthRabbitmqAdapter implements IHealthGatewayPort {
  private readonly targets: IProbeTarget[];

  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE) catalog: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE) inventory: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE) retail: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE) notification: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.EVENT_STORE_MICROSERVICE) eventStore: ClientProxy,
    @Inject(HEALTH_PROBE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {
    this.targets = [
      { name: 'catalog', client: catalog, routingKey: ROUTING_KEYS.CATALOG_HEALTH_PING },
      { name: 'inventory', client: inventory, routingKey: ROUTING_KEYS.INVENTORY_HEALTH_PING },
      { name: 'retail', client: retail, routingKey: ROUTING_KEYS.RETAIL_HEALTH_PING },
      {
        name: 'notification',
        client: notification,
        routingKey: ROUTING_KEYS.NOTIFICATION_HEALTH_PING,
      },
      { name: 'event-store', client: eventStore, routingKey: ROUTING_KEYS.AUDIT_HEALTH_PING },
    ];
  }

  public async probeAll(): Promise<Record<string, ServiceHealthView>> {
    const results = await Promise.all(this.targets.map((target) => this.probeOne(target)));
    return Object.fromEntries(results);
  }

  private async probeOne(target: IProbeTarget): Promise<[string, ServiceHealthView]> {
    const startedAt = Date.now();
    try {
      await firstValueFrom(
        target.client.send<IHealthPingResult>(target.routingKey, {}).pipe(timeout(this.timeoutMs)),
      );
      return [target.name, { status: 'ok', latencyMs: Date.now() - startedAt }];
    } catch (error) {
      const status = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error';
      return [target.name, { status }];
    }
  }
}
