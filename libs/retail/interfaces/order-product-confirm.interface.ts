import { OrderProductStatusEnum } from '../../retail';

export interface IOrderProductConfirm {
  id: number;
  productId: number;
  statusId: OrderProductStatusEnum;
}
