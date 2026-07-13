// DI token for the delivery-retention horizon, in days. A `ConfigService`-backed value provider in
// `notifications.module.ts` resolves it from `RETENTION_DELIVERY_DAYS` (Joi default 90), so
// `PurgeAgedDeliveriesUseCase` injects a plain `number` and never reads env — the
// `MAX_DELIVERY_ATTEMPTS` / `IDEMPOTENCY_KEY_TTL_HOURS` precedent.
//
// **The key existed for eleven epics and nothing read it** (ISSUE-08). It sat in the shared Joi
// schema that *every* service validates at boot, `.default(90)`, so an operator who set
// `RETENTION_DELIVERY_DAYS=7` got a clean boot, no warning, and **no purge** — the only way to find
// out was to grep the source, which is exactly what an operator will not do, because the key
// validates and has a sensible default.
//
// That is the defect worth naming: an unbuilt feature with **no** config key is honest. A validated,
// defaulted, boot-enforced key with **no reader** is a promise the schema makes and the code does not
// keep. This token is the reader.
export const RETENTION_DELIVERY_DAYS = Symbol('RETENTION_DELIVERY_DAYS');
