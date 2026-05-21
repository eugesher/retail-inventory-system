import { ValueObject } from '@retail-inventory-system/ddd';

interface IStorageProps extends Record<string, unknown> {
  id: string;
}

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
