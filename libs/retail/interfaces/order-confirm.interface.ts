import { ICorrelationPayload } from '../../common';
import { IOrderProductConfirm } from './order-product-confirm.interface';

export interface IOrderConfirmPayload extends ICorrelationPayload {
  id: number;
}

export interface IOrderConfirm extends IOrderConfirmPayload {
  products: IOrderProductConfirm[];
}
