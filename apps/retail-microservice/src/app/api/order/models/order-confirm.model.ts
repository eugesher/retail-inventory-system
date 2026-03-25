import {
  IOrderConfirm,
  IOrderProductConfirmItem,
  OrderProductStatusEnum,
} from '@retail-inventory-system/retail';

export class OrderConfirmModel {
  private _someProductsConfirmed: boolean;
  private _allProductsConfirmed: boolean;
  private _skipUpdate: boolean;

  constructor(
    private readonly order: IOrderConfirm,
    private readonly confirmedOrderProductIds: number[],
  ) {}

  public execute(): void {
    const confirmedOrderProductIdSet = new Set(this.confirmedOrderProductIds);
    const isConfirmed = (orderProduct: IOrderProductConfirmItem): boolean =>
      confirmedOrderProductIdSet.has(orderProduct.id) ||
      orderProduct.statusId === OrderProductStatusEnum.CONFIRMED;

    this._someProductsConfirmed = this.confirmedOrderProductIds.length > 0;
    this._allProductsConfirmed = this.order.products.every(isConfirmed);
    this._skipUpdate = !this._someProductsConfirmed && !this._allProductsConfirmed;
  }

  public get someProductsConfirmed(): boolean {
    return this._someProductsConfirmed;
  }

  public get allProductsConfirmed(): boolean {
    return this._allProductsConfirmed;
  }

  public get skipUpdate(): boolean {
    return this._skipUpdate;
  }
}
