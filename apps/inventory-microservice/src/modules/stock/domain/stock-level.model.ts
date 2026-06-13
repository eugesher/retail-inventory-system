// Per-location running totals for one variant at one location. Framework-free
// per ADR-004. This supersedes the append-only `product_stock` ledger: instead
// of summing signed deltas on every read, the three quantities are kept as
// maintained totals (ADR-027).
//
// `variantId` is an OPAQUE cross-service link to the catalog `product_variant`
// — the inventory domain MUST NOT import the catalog `ProductVariant`; the only
// coupling is the FK in persistence (ADR-004 / ADR-017 / ADR-025).

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

  // Sellable count: what is physically on hand minus what is already promised
  // (allocated to picks) and held (reserved against carts/orders).
  public get available(): number {
    return this._quantityOnHand - this._quantityAllocated - this._quantityReserved;
  }

  // On-hand mutation (Receive / Adjust). Every mutation bumps `version` so the
  // optimistic-concurrency token advances observably; the no-oversell invariant
  // the column guards is enforced by the reserve/release mutators below, all
  // running inside the same bounded version-checked write protocol (ADR-030 §3).
  public changeOnHand(delta: number): void {
    if (!Number.isInteger(delta)) {
      throw new Error(`StockLevel.changeOnHand: delta must be an integer, got ${delta}`);
    }
    const next = this._quantityOnHand + delta;
    if (next < 0) {
      // The one domain rejection on the write path that surfaces to an HTTP
      // caller — a signed Adjust that would drive on-hand below zero. Thrown as
      // a typed `InventoryDomainException` so the presentation filter maps it to
      // a 409 (the gateway's `throwRpcError` keys on the `statusCode`). The
      // message keeps the word "negative" so it stays self-describing in logs.
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
        `StockLevel.changeOnHand: resulting quantityOnHand would be negative (${next})`,
      );
    }
    this._quantityOnHand = next;
    this._version += 1;
  }

  // Holds `quantity` more units against carts/orders (ADR-030). **This is the
  // no-oversell guard**: a request for more than `available` is the one
  // reserve-side domain rejection that reaches an HTTP caller, thrown as a typed
  // `OUT_OF_STOCK` carrying the live `available` in structured `details` so a
  // client branches on the number, not the message text. A non-positive quantity
  // is an internal caller bug (the use case validates the request first and only
  // ever passes a positive delta here), so it is a plain `Error`, not a typed
  // exception the filter would surface as a 4xx. Bumps `version`.
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

  // Returns `quantity` held units to `available` (the Release / re-reserve-down
  // paths). Releasing more than is reserved is a counter drift — an invariant
  // breach, not user input — so it is a plain `Error` (surfaces as a 500, never
  // reachable through this capability's flows because the held quantity always
  // comes from the reservation row that occupied the counter). Bumps `version`.
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

  private static requirePositiveDelta(value: number, op: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`StockLevel.${op}: quantity must be a positive integer, got ${value}`);
    }
  }

  // Zeroed level for a freshly seen `(variantId, stockLocationId)` pair — used
  // by the auto-init consumer and lazy-init paths in later capabilities.
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
