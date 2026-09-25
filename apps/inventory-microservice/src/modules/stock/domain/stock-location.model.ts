export enum StockLocationTypeEnum {
  WAREHOUSE = 'warehouse',
  STORE = 'store',
  DROPSHIP_VIRTUAL = 'dropship-virtual',
}

interface IStockLocationProps {
  id: string;
  name: string;
  code: string;
  type: StockLocationTypeEnum;
  address?: Record<string, unknown> | null;
  gln?: string | null;
  active?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const GLN_PATTERN = /^\d{13}$/;

export class StockLocation {
  public readonly id: string;
  public readonly name: string;
  public readonly code: string;
  public readonly type: StockLocationTypeEnum;
  public readonly address: Record<string, unknown> | null;
  public readonly gln: string | null;
  private _active: boolean;
  public readonly createdAt?: Date;
  public readonly updatedAt?: Date;

  constructor(props: IStockLocationProps) {
    StockLocation.requireNonEmpty(props.id, 'id');
    StockLocation.requireNonEmpty(props.name, 'name');
    StockLocation.requireNonEmpty(props.code, 'code');

    const gln = props.gln ?? null;
    if (gln !== null && !GLN_PATTERN.test(gln)) {
      throw new Error(`StockLocation: gln must be 13 digits when present, got "${gln}"`);
    }

    this.id = props.id;
    this.name = props.name;
    this.code = props.code;
    this.type = props.type;
    this.address = props.address ?? null;
    this.gln = gln;
    this._active = props.active ?? true;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  private static requireNonEmpty(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`StockLocation: ${field} must be a non-empty string`);
    }
  }

  public get active(): boolean {
    return this._active;
  }

  public deactivate(): void {
    this._active = false;
  }
}
