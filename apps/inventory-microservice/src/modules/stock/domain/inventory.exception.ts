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

  constructor(code: InventoryErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
