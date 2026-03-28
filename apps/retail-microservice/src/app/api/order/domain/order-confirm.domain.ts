import {
  IOrderConfirm,
  IOrderProductConfirm,
  OrderProductStatusEnum,
} from '@retail-inventory-system/retail';

export class OrderConfirmDomain {
  public readonly someProductsConfirmed: boolean;
  public readonly allProductsConfirmed: boolean;
  public readonly skipUpdate: boolean;

  constructor(order: Omit<IOrderConfirm, 'correlationId'>, confirmedOrderProductIds: number[]) {
    const confirmedOrderProductIdSet = new Set(confirmedOrderProductIds);
    const isConfirmed = (orderProduct: IOrderProductConfirm): boolean =>
      confirmedOrderProductIdSet.has(orderProduct.id) ||
      orderProduct.statusId === OrderProductStatusEnum.CONFIRMED;

    this.someProductsConfirmed = confirmedOrderProductIds.length > 0;
    this.allProductsConfirmed = order.products.every(isConfirmed);
    this.skipUpdate = !this.someProductsConfirmed && !this.allProductsConfirmed;
  }
}
