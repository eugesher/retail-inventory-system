// DI tokens for the bounds and the cadence the expired-reservation sweep runs under
// (ADR-038). `ConfigService`-backed value providers in `stock.module.ts` resolve them from
// `RESERVATION_SWEEP_BATCH_SIZE` (Joi default 200),
// `RESERVATION_SWEEP_TRANSACTION_SIZE` (Joi default 25) and
// `RESERVATION_SWEEP_INTERVAL_SECONDS` (Joi default 60), so the sweep use case and its
// driver inject plain `number`s and never read env directly — the `RESERVATION_TTL_MINUTES`
// / `OCC_RETRY_ATTEMPTS` precedent (ADR-017). Provider tokens, not ports, but they live
// beside the ports so the wiring is greppable in one place.
//
// The three bound different things and are deliberately NOT one knob:
//   * batch size       — how many rows a single invocation may scan and expire. It caps
//                        the WORK per tick, so a backlog drains across successive sweeps
//                        instead of one unbounded pass.
//   * transaction size — how many rows one transaction expires. It caps the LOCK HOLD
//                        TIME, so the concurrent checkout writes the sweep races with
//                        never queue behind a long-running unit of work.
//   * interval seconds — how often an invocation happens. It decides only how PROMPTLY an
//                        already-expired hold is reclaimed; `RESERVATION_TTL_MINUTES` is
//                        what bounds a hold's life. Only the scheduler reads it.
export const RESERVATION_SWEEP_BATCH_SIZE = Symbol('RESERVATION_SWEEP_BATCH_SIZE');
export const RESERVATION_SWEEP_TRANSACTION_SIZE = Symbol('RESERVATION_SWEEP_TRANSACTION_SIZE');
export const RESERVATION_SWEEP_INTERVAL_SECONDS = Symbol('RESERVATION_SWEEP_INTERVAL_SECONDS');
