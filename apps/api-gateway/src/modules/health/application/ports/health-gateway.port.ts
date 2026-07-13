import { ServiceHealthView } from '@retail-inventory-system/contracts';

export const HEALTH_GATEWAY_PORT = Symbol('HEALTH_GATEWAY_PORT');

// The transport seam for the liveness fan-out (ADR-044). The adapter owns the five
// `ClientProxy` instances and the timeout; the use case owns what the result *means*.
//
// `probeAll` NEVER rejects. A downstream service being down is the answer this endpoint
// exists to give, not an error condition — so every per-service failure is folded into that
// service's `ServiceHealthView` (`timeout` / `error`) and the map always comes back whole.
// A port that could throw would force the use case to guess which services it had reached.
export interface IHealthGatewayPort {
  probeAll(): Promise<Record<string, ServiceHealthView>>;
}
