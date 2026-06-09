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

  // The only mutation this capability needs. `allocate`/`reserve`/`release`
  // belong to the later inventory-reservation capability and are intentionally
  // absent — shipping them now would be dead, untested code (ADR-027).
  //
  // Every mutation bumps `version` so the optimistic-concurrency token advances
  // observably, even though the no-oversell invariant it guards is enforced
  // later (the column ships now to make that retrofit non-destructive).
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
