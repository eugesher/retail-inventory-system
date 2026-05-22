import { ValueObject } from '@retail-inventory-system/ddd';

interface ICustomerRefProps extends Record<string, unknown> {
  id: number;
}

// Retail does not own a Customer aggregate — the `customer` table is
// read-only seed data, so Order holds it as a VO (ADR-013 §3).
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
