import { OrderProductStatusEnum } from '../enums';

export interface IOrderProductConfirmItem {
  id: number;
  productId: number;
  statusId: OrderProductStatusEnum;
}

export interface IOrderConfirm {
  id: number;
  products: IOrderProductConfirmItem[];
}
