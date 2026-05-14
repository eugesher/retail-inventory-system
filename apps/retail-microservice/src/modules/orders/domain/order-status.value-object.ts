import { OrderStatusEnum } from '@retail-inventory-system/contracts';
import { ValueObject } from '@retail-inventory-system/ddd';

interface IOrderStatusVOProps extends Record<string, unknown> {
  value: OrderStatusEnum;
}

// Order header status. Currently only PENDING / CONFIRMED exist; cancellation
// is on the recommendation roadmap but not enabled today. The VO wraps the
// enum so transition predicates (`isPending`, `isConfirmed`) belong on the
// type rather than scattered through use cases.
export class OrderStatusVO extends ValueObject<IOrderStatusVOProps> {
  public static readonly PENDING = new OrderStatusVO({ value: OrderStatusEnum.PENDING });
  public static readonly CONFIRMED = new OrderStatusVO({ value: OrderStatusEnum.CONFIRMED });

  constructor(props: IOrderStatusVOProps) {
    super(props);
  }

  public get value(): OrderStatusEnum {
    return this.props.value;
  }

  public isPending(): boolean {
    return this.props.value === OrderStatusEnum.PENDING;
  }

  public isConfirmed(): boolean {
    return this.props.value === OrderStatusEnum.CONFIRMED;
  }
}
