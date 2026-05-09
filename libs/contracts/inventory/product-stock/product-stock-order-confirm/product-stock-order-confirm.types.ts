import { ICorrelationPayload } from '@retail-inventory-system/common';

import { IOrderProductConfirm } from '../../../retail/interfaces';

export interface IProductStockOrderConfirmPayload extends ICorrelationPayload {
  products: IOrderProductConfirm[];
}
