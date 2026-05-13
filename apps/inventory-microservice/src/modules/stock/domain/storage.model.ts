import { ValueObject } from '@retail-inventory-system/ddd';

interface IStorageProps extends Record<string, unknown> {
  id: string;
}

// Value object wrapping the storage identifier. Constructor rejects empty
// strings; equality is structural via the base class. Today every ledger
// row resolves to `INVENTORY_DEFAULT_STORAGE`, but the type lifts the
// identifier into the domain so a future multi-warehouse model can attach
// behavior without re-typing every call site.
export class Storage extends ValueObject<IStorageProps> {
  constructor(id: string) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('Storage: id must be a non-empty string');
    }
    super({ id });
  }

  public get id(): string {
    return this.props.id;
  }
}
