import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every inventory invariant a caller can trip.
//
// **The code → HTTP status table is `presentation/inventory-rpc-exception.filter.ts`, and it is
// not restated here.** The domain stays transport-free: it names *what went wrong*, and the filter
// alone decides what that is worth over HTTP. A second copy of the mapping would drift from the
// one the code actually runs.
//
// What is worth saying is what the code names cannot:
export enum InventoryErrorCodeEnum {
  // Malformed input. The gateway DTOs normally catch these first — these are the backstop for the
  // RMQ path, which is directly reachable on the bus with no pipe in front of it.
  STOCK_RECEIVE_QUANTITY_INVALID = 'INVENTORY_STOCK_RECEIVE_QUANTITY_INVALID',
  STOCK_ADJUSTMENT_DELTA_INVALID = 'INVENTORY_STOCK_ADJUSTMENT_DELTA_INVALID',
  STOCK_ADJUSTMENT_REASON_REQUIRED = 'INVENTORY_STOCK_ADJUSTMENT_REASON_REQUIRED',

  // A transfer to the location it came from is rejected rather than treated as a no-op — it would
  // otherwise debit and credit the same row. **A source shortfall has no code of its own**:
  // `changeOnHand(−quantity)` already raises `STOCK_RESULT_NEGATIVE`, and unknown or inactive
  // locations reuse the two `STOCK_LOCATION_*` codes below.
  TRANSFER_QUANTITY_INVALID = 'INVENTORY_TRANSFER_QUANTITY_INVALID',
  TRANSFER_SAME_LOCATION = 'INVENTORY_TRANSFER_SAME_LOCATION',

  STOCK_LOCATION_NOT_FOUND = 'INVENTORY_STOCK_LOCATION_NOT_FOUND',
  STOCK_LOCATION_INACTIVE = 'INVENTORY_STOCK_LOCATION_INACTIVE',
  STOCK_RESULT_NEGATIVE = 'INVENTORY_STOCK_RESULT_NEGATIVE',

  // The version-checked write lost its race the bounded number of times. **The caller may simply
  // retry** — nothing is wrong with the request, only with its timing.
  STOCK_WRITE_CONFLICT = 'INVENTORY_STOCK_WRITE_CONFLICT',

  RESERVATION_QUANTITY_INVALID = 'INVENTORY_RESERVATION_QUANTITY_INVALID',

  // An illegal move on the hold's status machine — releasing one that is not active, reactivating
  // a `committed` one.
  RESERVATION_INVALID_STATE = 'INVENTORY_RESERVATION_INVALID_STATE',

  // `commit` on a hold whose `expiresAt` has passed — **even though the row still says `active`**,
  // because expiry is wall-clock and nothing flips the status until the sweep runs. Allocate
  // refreshes the TTL first when it decides to honour a stale-but-unswept hold, so this never
  // escapes from there.
  RESERVATION_EXPIRED = 'INVENTORY_RESERVATION_EXPIRED',

  // The no-oversell rejection (ADR-030 §3). **It carries the live `available` in `details`**, so a
  // client branches on the number rather than parsing a human message. The reserve-side twin of
  // `STOCK_RESULT_NEGATIVE`.
  OUT_OF_STOCK = 'INVENTORY_OUT_OF_STOCK',

  // **Only the by-id release path can raise this.** A release by `cartId` that matches nothing
  // returns an idempotent empty result instead — removing a line twice must not error, while
  // naming a hold that does not exist must.
  RESERVATION_NOT_FOUND = 'INVENTORY_RESERVATION_NOT_FOUND',

  // A release must carry **exactly one** selector family: `reservationId`, or `cartId` (optionally
  // narrowed). Both, or neither, is rejected here rather than silently guessed at.
  RESERVATION_SELECTOR_INVALID = 'INVENTORY_RESERVATION_SELECTOR_INVALID',
}

// **One throwable for the whole context** — the code, not the class, is what distinguishes a
// rejection. Every bounded context in this repo does the same, so a `catch` never has to enumerate
// exception types.
//
// Not every inventory failure comes through here, and that is deliberate: a **counter drift** is
// thrown as a plain `Error` (see `stock-level.model.ts`), because a typed exception would dress a
// broken invariant up as a business outcome and let a caller retry into it.
export class InventoryDomainException extends DomainException {
  public readonly code: InventoryErrorCodeEnum;
  // Structured payload forwarded intact through the RPC filter and the gateway error util
  // (ADR-030 §6), so a client branches on **data** — `{ available }` on an out-of-stock — instead
  // of parsing a human message that is free to change.
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
