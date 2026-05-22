import { OrderProductStatusEnum } from '@retail-inventory-system/contracts';
import { Entity } from '@retail-inventory-system/ddd';

import { OrderProductStatusVO } from './order-product-status.value-object';

interface IOrderProductProps {
  id: number | null;
  productId: number;
  status: OrderProductStatusVO;
}

export class OrderProduct extends Entity<number | null> {
  private _productId: number;
  private _status: OrderProductStatusVO;

  constructor(props: IOrderProductProps) {
    if (!Number.isInteger(props.productId) || props.productId <= 0) {
      throw new Error(`OrderProduct: productId must be a positive integer, got ${props.productId}`);
    }
    super(props.id);
    this._productId = props.productId;
    this._status = props.status;
  }

  public get productId(): number {
    return this._productId;
  }

  public get status(): OrderProductStatusVO {
    return this._status;
  }

  public get statusId(): OrderProductStatusEnum {
    return this._status.value;
  }

  public isPending(): boolean {
    return this._status.isPending();
  }

  public isConfirmed(): boolean {
    return this._status.isConfirmed();
  }

  public confirm(): void {
    this._status = OrderProductStatusVO.CONFIRMED;
  }
}
