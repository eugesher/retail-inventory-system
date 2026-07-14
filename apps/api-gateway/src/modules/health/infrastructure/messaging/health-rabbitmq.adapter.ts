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

// One probe target: the client that reaches a service, and the routing key it answers.
interface IProbeTarget {
  name: string;
  client: ClientProxy;
  routingKey: string;
}

// The liveness fan-out (ADR-044). The sole `ClientProxy` site of this module, holding one
// client per RMQ deployable.
//
// Each probe rides the service's EXISTING RPC queue — no new queue, no new exchange, nothing
// to provision. The event store is probed on `event_store_query_queue` (its default-exchange
// RPC transport, ADR-039), never on the `#`-bound firehose queue: `audit.health.ping` is a
// command, and the query transport's `wildcards: false` exact-match lookup resolves it while
// the firehose's `#` cannot.
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

  // CONCURRENT, and never rejecting — the endpoint's worst case is ONE timeout, not five.
  //
  // `Promise.all` is safe here only because `probeOne` swallows its own failures and resolves
  // to a `ServiceHealthView` either way. That is load-bearing: if `probeOne` could reject,
  // `all` would short-circuit on the first dead service and lose the status of the four that
  // answered — precisely the information the caller came for.
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
      // A `TimeoutError` means nobody answered in time — the service is down, wedged, or its
      // queue has no consumer. The gateway cannot distinguish those and does not guess.
      // Anything else came back as a real rejection from a live handler.
      const status = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error';
      return [target.name, { status }];
    }
  }
}
