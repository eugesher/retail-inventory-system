import { ICorrelationPayload } from '../../common';
import { OrderProductStatusEnum } from '../enums';

export interface IOrderConfirmPayload extends ICorrelationPayload {
  id: number;
  correlationId: string;
}

export interface IOrderProductConfirm {
  id: number;
  productId: number;
  statusId: OrderProductStatusEnum;
}

export interface IOrderConfirm extends IOrderConfirmPayload {
  products: IOrderProductConfirm[];
}
