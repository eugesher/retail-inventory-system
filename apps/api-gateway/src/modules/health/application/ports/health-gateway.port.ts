import { ServiceHealthView } from '@retail-inventory-system/contracts';

export const HEALTH_GATEWAY_PORT = Symbol('HEALTH_GATEWAY_PORT');

export interface IHealthGatewayPort {
  probeAll(): Promise<Record<string, ServiceHealthView>>;
}
