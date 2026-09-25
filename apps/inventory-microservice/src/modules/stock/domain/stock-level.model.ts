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

  public get available(): number {
    return this._quantityOnHand - this._quantityAllocated - this._quantityReserved;
  }

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

  public commitSale(quantity: number): void {
    StockLevel.requirePositiveDelta(quantity, 'commitSale');
    if (quantity > this._quantityAllocated) {
      throw new Error(
        `StockLevel.commitSale: cannot ship ${quantity}; only ${this._quantityAllocated} allocated`,
      );
    }
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
