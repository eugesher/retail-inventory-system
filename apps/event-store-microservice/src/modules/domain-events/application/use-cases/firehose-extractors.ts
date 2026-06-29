// Heuristic field resolvers for the firehose ingest. The `domain-events` module sinks
// EVERY business event the system publishes (the `#.#` topic-exchange firehose,
// docs/adr/035-event-store-firehose-topic-exchange.md), so it can assume nothing about a
// concrete payload's shape — there is no uniform `aggregateId` across producers, and the
// producer/aggregate identity is not carried as a field at all. These pure helpers
// recover the three indexed columns (`producer`, `aggregate_type`, `aggregate_id`) from
// what IS reliable: the dotted routing key and a documented precedence over the payload.
//
// Kept as framework-free functions (no DI, no I/O) so they are trivially unit-testable
// and reusable by the ingest use case. They never throw — a malformed routing key or a
// payload missing every known id falls through to a safe `''`, and the ingest use case
// decides whether the row is still worth appending.

// The first dotted token of a routing key (`<service>.<aggregate>.<action>`, ADR-008) is
// the producing service. We map it to the canonical microservice name the rest of the
// platform uses (`AppNameEnum` values) so the stored `producer` column reads the same as
// a service's own logs. `notification` and `notifications` both occur as a first token
// (the RPC keys use the singular, the reserved event uses the plural), so both alias to
// the one notification service.
const PRODUCER_BY_PREFIX: Readonly<Record<string, string>> = {
  inventory: 'inventory-microservice',
  retail: 'retail-microservice',
  catalog: 'catalog-microservice',
  notification: 'notification-microservice',
  notifications: 'notification-microservice',
};

// Resolve the producing service from the routing key's first token. An unmapped prefix
// (a producer added later, before this map is extended) falls back to the raw token
// rather than a lossy `''` — the row is still attributable, just not normalized.
export function resolveProducer(routingKey: string): string {
  const prefix = routingKey.split('.')[0] ?? '';
  return PRODUCER_BY_PREFIX[prefix] ?? prefix;
}

// Resolve the aggregate kind from the routing key's SECOND token — e.g.
// `retail.order.placed` → `order`, `inventory.stock-movement.recorded` → `stock-movement`.
// A degenerate key with no second token falls back to `''` (the column is non-null).
export function resolveAggregateType(routingKey: string): string {
  return routingKey.split('.')[1] ?? '';
}

// The precedence list for recovering the business aggregate's id from a payload, most
// specific first. `aggregateId` and `id` are the explicit/generic anchors; the rest are
// the per-aggregate id fields the platform's events actually carry (an `inventory.stock.*`
// event keys on `variantId`, a `retail.order.*` on `orderId`, an `inventory.reservation.*`
// on `reservationId`, …). The first present, non-null value wins and is stringified — a
// numeric BIGINT id (`orderId`) and a CHAR(36) UUID (`cartId`) both land as text in the
// VARCHAR column. A payload carrying none of these (rare — a pure notification ping) falls
// back to `''`; the event is still appended, just not addressable by aggregate id.
export const AGGREGATE_ID_KEYS: readonly string[] = [
  'aggregateId',
  'id',
  'orderId',
  'variantId',
  'cartId',
  'reservationId',
  'fulfillmentId',
  'returnRequestId',
  'returnLineId',
  'paymentId',
  'refundId',
  'movementId',
  'deliveryId',
  'templateId',
  'stockLocationId',
];

export function resolveAggregateId(payload: Record<string, unknown>): string {
  for (const key of AGGREGATE_ID_KEYS) {
    const value = payload[key];
    // An aggregate id is always a scalar — a BIGINT (`orderId`) or a string UUID
    // (`cartId`). Narrow to the primitive id types before stringifying, so a stray
    // object under an id key falls through to the next candidate rather than landing as
    // a useless `'[object Object]'`. null/undefined are skipped the same way.
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return value.toString();
    }
  }
  return '';
}
