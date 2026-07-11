import { ApiResponseProperty } from '@nestjs/swagger';

// The reply every microservice returns from its `<svc>.health.ping` RPC. Deliberately the
// thinnest possible liveness answer: the handler does no I/O, touches no repository, and
// opens no connection. It answers exactly one question — *is a Nest app consuming this
// queue?* — because that is the only question a single RPC can answer honestly.
//
// It is NOT a readiness probe. A service whose MySQL is down still replies `ok` here, and
// that is correct: adding a DB round-trip would turn every health poll into load on the hot
// path and would make one slow database report five services as sick.
export interface IHealthPingResult {
  status: 'ok';
  service: string;
}

// The status of one downstream service as the gateway observed it.
//
//   `ok`      — the service replied within the probe timeout.
//   `timeout` — no reply within `HEALTH_PROBE_TIMEOUT_MS`. The service is down, wedged, or
//               its queue has no consumer. The gateway cannot tell these apart, and does not
//               pretend to.
//   `error`   — the RPC came back, but as a rejection.
export type ServiceHealthStatus = 'ok' | 'timeout' | 'error';

export class ServiceHealthView {
  @ApiResponseProperty({ example: 'ok' })
  public status!: ServiceHealthStatus;

  // Round-trip latency of the probe, present only on `ok`. Useful precisely because it is
  // measured through the real transport: a rising number means RabbitMQ or the consumer is
  // struggling, well before the timeout starts firing.
  @ApiResponseProperty({ example: 4 })
  public latencyMs?: number;
}

// The system-wide answer served by `GET /api/health`.
//
// `status` is `ok` only when every probed service replied `ok`; any other outcome makes it
// `degraded`. There is no `down`: the gateway answering at all proves the gateway is up, and
// a system with one sick service is degraded, not dead.
//
// The endpoint returns **200 in both cases**. This is a *report*, not the gateway's own
// liveness signal — a monitor reads `status` and the per-service map. Returning 503 here
// would make the gateway look dead because notification is, which is the opposite of what the
// caller asked.
export class SystemHealthView {
  @ApiResponseProperty({ example: 'degraded' })
  public status!: 'ok' | 'degraded';

  @ApiResponseProperty()
  public services!: Record<string, ServiceHealthView>;
}
