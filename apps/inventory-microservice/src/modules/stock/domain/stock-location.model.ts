// The physical (or virtual) place stock is held. Framework-free per ADR-004:
// no `@nestjs/*`, no `typeorm`, no `class-validator` on the model — invariants
// throw a plain `Error`, matching the pre-existing stock domain style (the
// inventory context has no `DomainException` subclass yet).

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

// A GLN (Global Location Number) is exactly 13 digits when present.
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
    // `active` is the lifecycle flag; soft-delete flips it to `false`. The
    // persistence layer's inherited `deletedAt` column stays inert (ADR-027),
    // mirroring how the catalog tables leave `deletedAt` untouched.
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

  // Soft-delete via the `active` flag — never a `deletedAt` timestamp. `code`
  // uniqueness is repository-level (a UNIQUE constraint), not model-enforced:
  // the aggregate cannot see its siblings, so it trusts the repository (mirrors
  // the catalog `slug`/`sku` convention, ADR-025).
  public deactivate(): void {
    this._active = false;
  }
}
