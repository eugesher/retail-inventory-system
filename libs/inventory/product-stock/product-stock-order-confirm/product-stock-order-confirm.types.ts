import { ICorrelationPayload } from '../../../common';
import { IOrderProductConfirm } from '../../../retail';

export interface IProductStockOrderConfirmPayload extends ICorrelationPayload {
  products: IOrderProductConfirm[];
}
