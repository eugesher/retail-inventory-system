import { OrderProductStatusEnum } from '../enums';

export interface IOrderProductConfirm {
  id: number;
  productId: number;
  statusId: OrderProductStatusEnum;
}
