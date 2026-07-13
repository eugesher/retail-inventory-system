// DI token for the per-service probe timeout, resolved from `HEALTH_PROBE_TIMEOUT_MS`
// (Joi default 2000) by a `ConfigService`-backed value provider in `health.module.ts` — a use
// case never reads `process.env` (ADR-017).
//
// It bounds ONE probe, not the fan-out: the five run concurrently, so the endpoint's worst
// case is this timeout, not five times it.
export const HEALTH_PROBE_TIMEOUT_MS = Symbol('HEALTH_PROBE_TIMEOUT_MS');
