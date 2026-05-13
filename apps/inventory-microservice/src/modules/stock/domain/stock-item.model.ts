interface IStockItemProps {
  productId: number;
  storageId: string;
  quantity: number;
  reservedQuantity?: number;
  updatedAt?: Date | null;
}

// Aggregated stock state for a single (productId, storageId) pair. Pure
// class — no framework imports. The constructor enforces:
//   - `quantity >= 0` (an aggregate net of all signed ledger deltas)
//   - `reservedQuantity >= 0`
//   - `reservedQuantity <= quantity` (cannot reserve more than is on hand)
//
// `reservedQuantity` defaults to 0 because the persistence model today is a
// single signed ledger (`product_stock`) and does not record reservations
// separately. The field exists in the domain because reservation semantics
// belong here, not in the adapter; future ledger evolutions (a dedicated
// reservations column or a separate ledger) become invisible to callers.
export class StockItem {
  public readonly productId: number;
  public readonly storageId: string;
  private _quantity: number;
  private _reservedQuantity: number;
  public readonly updatedAt: Date | null;

  constructor(props: IStockItemProps) {
    const reservedQuantity = props.reservedQuantity ?? 0;

    if (!Number.isFinite(props.quantity) || props.quantity < 0) {
      throw new Error(
        `StockItem: quantity must be a non-negative finite number, got ${props.quantity}`,
      );
    }
    if (!Number.isFinite(reservedQuantity) || reservedQuantity < 0) {
      throw new Error(
        `StockItem: reservedQuantity must be a non-negative finite number, got ${reservedQuantity}`,
      );
    }
    if (reservedQuantity > props.quantity) {
      throw new Error(
        `StockItem: reservedQuantity (${reservedQuantity}) must not exceed quantity (${props.quantity})`,
      );
    }

    this.productId = props.productId;
    this.storageId = props.storageId;
    this._quantity = props.quantity;
    this._reservedQuantity = reservedQuantity;
    this.updatedAt = props.updatedAt ?? null;
  }

  public get quantity(): number {
    return this._quantity;
  }

  public get reservedQuantity(): number {
    return this._reservedQuantity;
  }

  public get availableQuantity(): number {
    return this._quantity - this._reservedQuantity;
  }

  public reserve(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`StockItem.reserve: amount must be a positive finite number, got ${amount}`);
    }
    if (amount > this.availableQuantity) {
      throw new Error(
        `StockItem.reserve: requested ${amount} exceeds available ${this.availableQuantity}`,
      );
    }
    this._reservedQuantity += amount;
  }

  public release(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`StockItem.release: amount must be a positive finite number, got ${amount}`);
    }
    if (amount > this._reservedQuantity) {
      throw new Error(
        `StockItem.release: requested ${amount} exceeds reserved ${this._reservedQuantity}`,
      );
    }
    this._reservedQuantity -= amount;
  }
}
