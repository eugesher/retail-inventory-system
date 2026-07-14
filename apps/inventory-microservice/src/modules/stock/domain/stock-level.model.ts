// Per-location running totals for one variant: three maintained counters rather than a ledger
// summed on every read (ADR-027). `variantId` is an **opaque** link to the catalog — inventory
// never imports a catalog type, and the only coupling is an FK in persistence (ADR-025).
//
// **Two kinds of failure, and the distinction is the design.** Every mutator below picks one, and
// which one it picks says what the condition *means*:
//
//   * a typed `InventoryDomainException` → a state a caller can legitimately reach. The
//     presentation filter maps it to a **409**, and `OUT_OF_STOCK` carries the live `available` in
//     structured `details` so a client branches on the number, not on message text.
//   * a plain `Error` → **counter drift**: a state reachable only through an internal bug. It
//     surfaces as a 500, on purpose. Making it typed would dress a broken invariant up as a
//     business outcome and let a caller retry into it.
//
// Every mutation bumps `version`, and each is exactly ONE bump — so the version-checked write
// persists it in a single `UPDATE`. `domain/spec/stock-level.model.spec.ts` pins all of it: the
// boundaries, the version bumps, and which failure each over-ask produces.

import { InventoryDomainException, InventoryErrorCodeEnum } from './inventory.exception';

interface IStockLevelProps {
  id?: number | null;
  variantId: number;
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  version: number;
  updatedAt?: Date | null;
}

export class StockLevel {
  public readonly id: number | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  private _quantityOnHand: number;
  private _quantityAllocated: number;
  private _quantityReserved: number;
  private _version: number;
  public readonly updatedAt: Date | null;

  constructor(props: IStockLevelProps) {
    this._quantityOnHand = StockLevel.requireNonNegativeInt(props.quantityOnHand, 'quantityOnHand');
    this._quantityAllocated = StockLevel.requireNonNegativeInt(
      props.quantityAllocated,
      'quantityAllocated',
    );
    this._quantityReserved = StockLevel.requireNonNegativeInt(
      props.quantityReserved,
      'quantityReserved',
    );
    this._version = StockLevel.requireNonNegativeInt(props.version, 'version');

    this.id = props.id ?? null;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this.updatedAt = props.updatedAt ?? null;
  }

  private static requireNonNegativeInt(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`StockLevel: ${field} must be a non-negative integer, got ${value}`);
    }
    return value;
  }

  public get quantityOnHand(): number {
    return this._quantityOnHand;
  }

  public get quantityAllocated(): number {
    return this._quantityAllocated;
  }

  public get quantityReserved(): number {
    return this._quantityReserved;
  }

  public get version(): number {
    return this._version;
  }

  // Sellable count — derived, never stored. On hand, minus what is promised to picks, minus what
  // is held against carts.
  //
  // **It can go NEGATIVE, and nothing guards that.** `changeOnHand` only refuses to drive
  // *on-hand* below zero; it does not refuse to drive on-hand below what is already committed. Ship
  // a negative Adjust at a location with live allocations and `available` goes under. Do not treat
  // a non-negative `available` as an invariant — the spec pins the negative case deliberately.
  public get available(): number {
    return this._quantityOnHand - this._quantityAllocated - this._quantityReserved;
  }

  // Receive / Adjust. The guard is on **on-hand**, not on `available`: driving on-hand below zero
  // is refused, driving `available` below zero is not (see the getter above).
  public changeOnHand(delta: number): void {
    if (!Number.isInteger(delta)) {
      throw new Error(`StockLevel.changeOnHand: delta must be an integer, got ${delta}`);
    }
    const next = this._quantityOnHand + delta;
    if (next < 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
        `StockLevel.changeOnHand: resulting quantityOnHand would be negative (${next})`,
      );
    }
    this._quantityOnHand = next;
    this._version += 1;
  }

  // **The no-oversell guard** (ADR-030). Reserving exactly `available` is legal; one more is
  // `OUT_OF_STOCK`.
  public reserve(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'reserve');
    if (quantity > this.available) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.OUT_OF_STOCK,
        `StockLevel.reserve: cannot reserve ${quantity} of variant ${this.variantId} @ ` +
          `${this.stockLocationId} — only ${this.available} available`,
        { available: this.available },
      );
    }
    this._quantityReserved += quantity;
    this._version += 1;
  }

  // Returns held units to `available`. Over-releasing is **drift, not input**: the quantity always
  // comes from the reservation row that occupied the counter, so exceeding it means the two have
  // diverged. Plain `Error`.
  public releaseReserved(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'releaseReserved');
    if (quantity > this._quantityReserved) {
      throw new Error(
        `StockLevel.releaseReserved: cannot release ${quantity}; only ${this._quantityReserved} reserved`,
      );
    }
    this._quantityReserved -= quantity;
    this._version += 1;
  }

  // Turns a hold into a pick at order placement (ADR-030 §4). **A pure transfer: `available` does
  // not move**, because both counters subtract from it. Over-asking is drift, as in
  // `releaseReserved`.
  public allocateFromReserved(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'allocateFromReserved');
    if (quantity > this._quantityReserved) {
      throw new Error(
        `StockLevel.allocateFromReserved: cannot move ${quantity} from reserved; only ${this._quantityReserved} reserved`,
      );
    }
    this._quantityReserved -= quantity;
    this._quantityAllocated += quantity;
    this._version += 1;
  }

  // Allocates straight from `available` with **no prior hold** — the fallback when an order line
  // never reserved, or when a stale hold had to be re-balanced. **The second no-oversell guard**: a
  // place that out-runs stock fails with `OUT_OF_STOCK` rather than overselling.
  public allocateDirect(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'allocateDirect');
    if (quantity > this.available) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.OUT_OF_STOCK,
        `StockLevel.allocateDirect: cannot allocate ${quantity} of variant ${this.variantId} @ ` +
          `${this.stockLocationId} — only ${this.available} available`,
        { available: this.available },
      );
    }
    this._quantityAllocated += quantity;
    this._version += 1;
  }

  // Returns allocated units to `available` (Cancel Allocation, ADR-030 §4).
  //
  // **This is the one over-release that is NOT drift.** A Cancel RPC arrives from outside and may
  // carry a wrong quantity, so exceeding what is allocated is a caller error, not a broken
  // invariant — hence a typed `409`, where the reserved-side siblings raise a plain `Error`.
  public releaseAllocated(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'releaseAllocated');
    if (quantity > this._quantityAllocated) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
        `StockLevel.releaseAllocated: cannot release ${quantity} allocated of variant ${this.variantId} @ ` +
          `${this.stockLocationId} — only ${this._quantityAllocated} allocated`,
      );
    }
    this._quantityAllocated -= quantity;
    this._version += 1;
  }

  // **The one mutation on which stock physically leaves.** It decrements on-hand *and* allocated
  // together, in a single `version` bump.
  //
  // **`available` is UNCHANGED by a commit-sale** — both decremented counters subtract from it, so
  // they cancel. That is exactly right: shipping stock that was already promised neither frees nor
  // consumes availability. `quantityReserved` is never touched.
  public commitSale(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'commitSale');
    // Drift: the fulfillment lines were built from this order's own allocation, so shipping more
    // than is allocated can only be an internal bug.
    if (quantity > this._quantityAllocated) {
      throw new Error(
        `StockLevel.commitSale: cannot ship ${quantity}; only ${this._quantityAllocated} allocated`,
      );
    }
    // Not drift: a prior negative Adjust can leave physical on-hand below what is allocated, and an
    // operator can reach that. Shipping then would drive on-hand negative — a typed 409, not a 500.
    if (quantity > this._quantityOnHand) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
        `StockLevel.commitSale: shipping ${quantity} of variant ${this.variantId} @ ` +
          `${this.stockLocationId} would drive on-hand negative (only ${this._quantityOnHand} on hand)`,
      );
    }
    this._quantityOnHand -= quantity;
    this._quantityAllocated -= quantity;
    this._version += 1;
  }

  private static requirePositiveDelta(value: number, op: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`StockLevel.${op}: quantity must be a positive integer, got ${value}`);
    }
  }

  // A zeroed level at version 0, for a `(variantId, stockLocationId)` pair nothing has stocked yet.
  public static initialAt(variantId: number, stockLocationId: string): StockLevel {
    return new StockLevel({
      id: null,
      variantId,
      stockLocationId,
      quantityOnHand: 0,
      quantityAllocated: 0,
      quantityReserved: 0,
      version: 0,
    });
  }
}
