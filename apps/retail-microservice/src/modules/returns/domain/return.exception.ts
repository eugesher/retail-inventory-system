import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every returns-context invariant violation — covering
// the `ReturnRequest` root and its `ReturnLine` children. The returns module is its
// **own bounded context** (the RMA lifecycle is a substantial six-state machine with
// warehouse-facing operations distinct from order placement), so it gets its **own
// concrete throwable** rather than reusing `OrderDomainException` — the same
// one-class-per-module convention `OrderDomainException` / `InventoryDomainException`
// / `CatalogDomainException` follow. The code is the part a presentation-layer
// exception filter maps onto an HTTP status + wire error shape
// (`{ statusCode, message, code }`); the domain itself stays transport-free. The HTTP
// filter that maps these arrives with the returns operations, not this foundation — so
// **every** code is declared now (the filter's `Record` is total) even though the
// foundation throws only a few; each is annotated with its thrower.
export enum ReturnErrorCodeEnum {
  // --- Thrown by the domain model (this foundation) ---
  // A return request must carry at least one line — thrown by `ReturnRequest.open`,
  // 400.
  RETURN_NO_LINES = 'RETURN_NO_LINES',
  // A return line quantity must be a positive integer — thrown by the `ReturnLine`
  // constructor, 400.
  RETURN_LINE_QUANTITY_INVALID = 'RETURN_LINE_QUANTITY_INVALID',
  // A status mutator was called from a state that does not allow it (`authorize`/
  // `reject` off non-`requested`, `receive` off non-`authorized`, `markInspected` off
  // non-`received`, `close` off non-`inspected`) — a well-formed request the resource
  // state forbids, thrown by the `ReturnRequest` mutators, 409.
  RETURN_INVALID_STATUS_TRANSITION = 'RETURN_INVALID_STATUS_TRANSITION',
  // An inspection recorded a bad condition/disposition enum or a negative refund
  // amount — thrown by `ReturnLine.inspect`, 400. (The Inspect use case also raises it
  // for cross-aggregate inspection breaches in a later capability.)
  RETURN_INSPECTION_INVALID = 'RETURN_INSPECTION_INVALID',

  // --- Thrown by the use cases (later tasks) ---
  // The return request being read/operated on does not exist — 404 (the read +
  // authorize/reject/receive/inspect/close operations resolve an RMA by id).
  RETURN_NOT_FOUND = 'RETURN_NOT_FOUND',
  // The authenticated caller is neither the RMA's owner (the order's buyer) nor a
  // staff override — the retail-side half of the owner-or-staff check on Open + the
  // reads, 403.
  RETURN_ACCESS_FORBIDDEN = 'RETURN_ACCESS_FORBIDDEN',
  // The order a return is being opened against does not exist — 404 (Open resolves the
  // order through the raw-SQL reader port).
  RETURN_ORDER_NOT_FOUND = 'RETURN_ORDER_NOT_FOUND',
  // The order cannot be returned in its current state — it is neither `delivered` nor
  // `shipped` within the return window — 409 (Open).
  RETURN_ORDER_NOT_RETURNABLE = 'RETURN_ORDER_NOT_RETURNABLE',
  // The order is outside the configured `RETURN_WINDOW_DAYS` return window — 409
  // (Open).
  RETURN_WINDOW_EXPIRED = 'RETURN_WINDOW_EXPIRED',
  // The Σ requested quantity for an order line exceeds the returnable remainder
  // (ordered − cancelled − already-returned) — the cross-line returnable-quantity
  // invariant the Open use case enforces (the aggregate cannot see the order's line
  // quantities) — 409 (Open).
  RETURN_QUANTITY_EXCEEDS_RETURNABLE = 'RETURN_QUANTITY_EXCEEDS_RETURNABLE',
  // A requested `orderLineId` does not name a line on the order — 404 (Open).
  RETURN_ORDER_LINE_NOT_FOUND = 'RETURN_ORDER_LINE_NOT_FOUND',
  // A `returnLineId` referenced by an inspect request does not exist on the RMA — 404
  // (Inspect, a later capability).
  RETURN_LINE_NOT_FOUND = 'RETURN_LINE_NOT_FOUND',
}

// One concrete throwable for the returns bounded context, carrying a typed `code`
// from `ReturnErrorCodeEnum`. Satisfies the framework-free `DomainException` base's
// abstract `code` contract (ADR-025 pattern). Assert `err.code`, never string-match
// the message.
export class ReturnDomainException extends DomainException {
  public readonly code: ReturnErrorCodeEnum;

  constructor(code: ReturnErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
