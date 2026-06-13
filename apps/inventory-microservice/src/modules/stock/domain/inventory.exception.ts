import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every inventory domain / write-path invariant
// violation. The code is the part the presentation-layer
// `InventoryRpcExceptionFilter` maps onto an HTTP status + wire error shape
// (`{ statusCode, message, code }`); the domain itself stays transport-free
// (ADR-027, mirroring the catalog/pricing filters — ADR-025 / ADR-026).
export enum InventoryErrorCodeEnum {
  // Malformed-input invariants → 400. Normally caught by the gateway request
  // DTOs first; these are the backstop for the directly-reachable RMQ path.
  STOCK_RECEIVE_QUANTITY_INVALID = 'INVENTORY_STOCK_RECEIVE_QUANTITY_INVALID',
  STOCK_ADJUSTMENT_DELTA_INVALID = 'INVENTORY_STOCK_ADJUSTMENT_DELTA_INVALID',
  STOCK_ADJUSTMENT_REASON_REQUIRED = 'INVENTORY_STOCK_ADJUSTMENT_REASON_REQUIRED',

  // Lookup miss → 404: the named stock location does not exist.
  STOCK_LOCATION_NOT_FOUND = 'INVENTORY_STOCK_LOCATION_NOT_FOUND',

  // Conflicts with current state → 409: the request is well-formed but clashes
  // with what is persisted — the location is deactivated, or applying the delta
  // would drive on-hand below zero.
  STOCK_LOCATION_INACTIVE = 'INVENTORY_STOCK_LOCATION_INACTIVE',
  STOCK_RESULT_NEGATIVE = 'INVENTORY_STOCK_RESULT_NEGATIVE',

  // Optimistic-concurrency exhaustion → 409: the write retried the version-checked
  // update the bounded number of times and still lost the race to a concurrent
  // writer on the same `(variantId, stockLocationId)`. The caller may simply retry.
  STOCK_WRITE_CONFLICT = 'INVENTORY_STOCK_WRITE_CONFLICT',

  // Reservation invariants (ADR-030). The TTL-bounded, cart-scoped hold the
  // inventory-reservation capability builds on. The aggregate enforces these now;
  // the Reserve / Release / Allocate use cases that surface them to a caller land
  // in later sessions.
  //
  // Malformed input → 400: a non-positive / non-integer reserved quantity.
  RESERVATION_QUANTITY_INVALID = 'INVENTORY_RESERVATION_QUANTITY_INVALID',
  // Illegal status-machine move → 409: e.g. releasing a non-active hold, or
  // reactivating a committed one. The request is well-formed but clashes with the
  // hold's current lifecycle state.
  RESERVATION_INVALID_STATE = 'INVENTORY_RESERVATION_INVALID_STATE',
  // Wall-clock-expired commit → 409: `commit` was called on a hold whose
  // `expiresAt` is already in the past. The allocate use case (a later capability)
  // refreshes the TTL first when it decides to honor a stale-but-still-held hold.
  RESERVATION_EXPIRED = 'INVENTORY_RESERVATION_EXPIRED',

  // No-oversell rejection → 409 (ADR-030 §3): a Reserve asked for more than the
  // variant's `available` at the location. Carries the live `available` in the
  // exception's structured `details` so a client branches on the number, not the
  // human message. The reserve-side counterpart of `STOCK_RESULT_NEGATIVE`.
  OUT_OF_STOCK = 'INVENTORY_OUT_OF_STOCK',

  // Release-by-id miss → 404: the `reservationId` selector named a hold that does
  // not exist. (The release-by-cart selector returns an idempotent empty result on
  // a no-match instead — only the precise by-id path 404s.)
  RESERVATION_NOT_FOUND = 'INVENTORY_RESERVATION_NOT_FOUND',

  // Malformed Release selector → 400: a release request must carry EXACTLY one
  // selector family — either `reservationId` (one row) or `cartId` (+ optional
  // `variantId` / `stockLocationId`, all matching active rows). Supplying both, or
  // neither, is rejected here.
  RESERVATION_SELECTOR_INVALID = 'INVENTORY_RESERVATION_SELECTOR_INVALID',
}

// The inventory bounded context's concrete `DomainException` (the third in the
// repo, after `CatalogDomainException` and `PricingDomainException`). A single
// throwable per context carries a typed `code` from `InventoryErrorCodeEnum`,
// satisfying the base's abstract `code` contract while keeping the domain
// transport-free — HTTP status is decided by the presentation filter, never here
// (ADR-027). The earlier inventory model threw plain `Error`; the Receive/Adjust
// write path is the first inventory flow that surfaces a domain rejection to an
// HTTP caller, so it needs a typed, mappable error.
export class InventoryDomainException extends DomainException {
  public readonly code: InventoryErrorCodeEnum;
  // Optional structured payload forwarded through the RPC filter and the gateway
  // error util (ADR-030 §6), so a client branches on data (e.g. `{ available }` on
  // an out-of-stock rejection) rather than parsing the human message. Frozen-shaped
  // (`Readonly`) because it is read, never mutated, downstream.
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: InventoryErrorCodeEnum,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
