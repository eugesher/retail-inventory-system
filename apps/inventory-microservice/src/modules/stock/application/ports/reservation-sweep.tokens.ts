// DI tokens for the two bounds the expired-reservation sweep runs under (ADR-038).
// `ConfigService`-backed value providers in `stock.module.ts` resolve them from
// `RESERVATION_SWEEP_BATCH_SIZE` (Joi default 200) and
// `RESERVATION_SWEEP_TRANSACTION_SIZE` (Joi default 25), so the sweep use case injects
// plain `number`s and never reads env directly — the `RESERVATION_TTL_MINUTES` /
// `OCC_RETRY_ATTEMPTS` precedent (ADR-017). Provider tokens, not ports, but they live
// beside the ports so the use-case wiring is greppable in one place.
//
// The two bound different things and are deliberately NOT one knob:
//   * batch size       — how many rows a single invocation may scan and expire. It caps
//                        the WORK per tick, so a backlog drains across successive sweeps
//                        instead of one unbounded pass.
//   * transaction size — how many rows one transaction expires. It caps the LOCK HOLD
//                        TIME, so the concurrent checkout writes the sweep races with
//                        never queue behind a long-running unit of work.
export const RESERVATION_SWEEP_BATCH_SIZE = Symbol('RESERVATION_SWEEP_BATCH_SIZE');
export const RESERVATION_SWEEP_TRANSACTION_SIZE = Symbol('RESERVATION_SWEEP_TRANSACTION_SIZE');
