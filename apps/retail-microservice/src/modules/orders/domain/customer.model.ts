import { ValueObject } from '@retail-inventory-system/ddd';

interface ICustomerRefProps extends Record<string, unknown> {
  id: number;
}

// Order owns its customer reference. Today retail does not maintain a
// Customer aggregate of its own (the `customer` table is read-only seed
// data); the domain models Customer as a VO referenced by Order so the
// domain layer stays framework-free and the persistence side is free to
// evolve independently.
export class CustomerRef extends ValueObject<ICustomerRefProps> {
  constructor(props: ICustomerRefProps) {
    if (!Number.isInteger(props.id) || props.id <= 0) {
      throw new Error(`CustomerRef: id must be a positive integer, got ${props.id}`);
    }
    super(props);
  }

  public get id(): number {
    return this.props.id;
  }
}
