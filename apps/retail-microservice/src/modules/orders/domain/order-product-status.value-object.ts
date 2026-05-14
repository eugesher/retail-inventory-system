import { OrderProductStatusEnum } from '@retail-inventory-system/contracts';
import { ValueObject } from '@retail-inventory-system/ddd';

interface IOrderProductStatusVOProps extends Record<string, unknown> {
  value: OrderProductStatusEnum;
}

export class OrderProductStatusVO extends ValueObject<IOrderProductStatusVOProps> {
  public static readonly PENDING = new OrderProductStatusVO({
    value: OrderProductStatusEnum.PENDING,
  });
  public static readonly CONFIRMED = new OrderProductStatusVO({
    value: OrderProductStatusEnum.CONFIRMED,
  });

  constructor(props: IOrderProductStatusVOProps) {
    super(props);
  }

  public get value(): OrderProductStatusEnum {
    return this.props.value;
  }

  public isPending(): boolean {
    return this.props.value === OrderProductStatusEnum.PENDING;
  }

  public isConfirmed(): boolean {
    return this.props.value === OrderProductStatusEnum.CONFIRMED;
  }
}
