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
  // amount — thrown by `ReturnLine.inspect`, 400. The Inspect use case raises the same code for
  // the two breaches a single line cannot see: **inspecting one line twice, and not inspecting
  // them all.** An inspection is all-or-nothing — one request must cover every line on the RMA.
  RETURN_INSPECTION_INVALID = 'RETURN_INSPECTION_INVALID',
  // Optimistic-concurrency conflict on a return-request status write → 409 (ADR-036).
  // Two staff raced the same RMA's lifecycle and the bounded retry budget was exhausted
  // — the root `version` moved under the writer on every attempt. The **member name**
  // keeps the `RETURN_` prefix (the module convention) but the **wire value** is the
  // uniform cross-service `VERSION_MISMATCH` — so a client branches on one code
  // regardless of which aggregate lost the race (cart / order / fulfillment / return) —
  // and the exception's `details.currentVersion` carries the row's now-current version
  // so the caller can refetch-and-retry (the cart `CART_VERSION_MISMATCH` / order
  // `ORDER_VERSION_MISMATCH` precedent). Distinct from `RETURN_INVALID_STATUS_TRANSITION`
  // (a state the transition genuinely forbids) — both mean "you lost the race", but only
  // the CAS loss is retried.
  RETURN_VERSION_MISMATCH = 'VERSION_MISMATCH',

  // --- Thrown by the use cases ---
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
  // A `returnLineId` referenced by an inspect request does not exist on the RMA — 404 (Inspect).
  RETURN_LINE_NOT_FOUND = 'RETURN_LINE_NOT_FOUND',
}

// One concrete throwable for the returns bounded context, carrying a typed `code`
// from `ReturnErrorCodeEnum`. Satisfies the framework-free `DomainException` base's
// abstract `code` contract (ADR-025 pattern). Assert `err.code`, never string-match
// the message.
export class ReturnDomainException extends DomainException {
  public readonly code: ReturnErrorCodeEnum;
  // Optional structured payload forwarded through the RPC filter and the gateway error
  // util (the cart `{ currentVersion }` / order `{ currentVersion }` precedent), so a
  // client branches on data rather than parsing the human message. The OCC conflict
  // carries `{ currentVersion }` here so the caller can refetch-and-retry. Frozen-shaped
  // (`Readonly`) because it is read, never mutated, downstream.
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ReturnErrorCodeEnum,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
