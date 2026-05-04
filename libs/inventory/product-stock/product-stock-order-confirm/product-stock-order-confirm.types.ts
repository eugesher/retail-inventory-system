import { ICorrelationPayload, IOrderProductConfirm } from '../../../common';

export interface IProductStockOrderConfirmPayload extends ICorrelationPayload {
  products: IOrderProductConfirm[];
}
