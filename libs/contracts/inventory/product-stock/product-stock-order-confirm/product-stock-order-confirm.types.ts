import { ICorrelationPayload } from '../../../microservices';
import { IOrderProductConfirm } from '../../../retail/interfaces';

export interface IProductStockOrderConfirmPayload extends ICorrelationPayload {
  products: IOrderProductConfirm[];
}
