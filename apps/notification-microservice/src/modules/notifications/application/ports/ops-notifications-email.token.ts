// DI token for the operations mailbox that system/ops notifications are sent to (ADR-033).
// A `ConfigService`-backed value provider in `notifications.module.ts` resolves it from the
// `OPS_NOTIFICATIONS_EMAIL` env (Joi default `ops@example.com`), so a consumer injects a
// plain `string` rather than reading env directly — the `MAX_DELIVERY_ATTEMPTS` /
// `RETURN_WINDOW_DAYS` value-provider precedent. It is a provider token, not a port, but
// lives next to the ports so the consumer wiring is greppable in one place.
//
// Today its only consumer is `InventoryEventsConsumer`: a low-stock alert has no customer
// recipient (`recipientCustomerId = null`), so it dispatches to this mailbox instead of a
// buyer email.
export const OPS_NOTIFICATIONS_EMAIL = Symbol('OPS_NOTIFICATIONS_EMAIL');
