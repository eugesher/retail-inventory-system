// REVIEW-FIX: ARCH-001 — import from common instead of retail to break cross-lib dependency
import { ICorrelationPayload, IOrderProductConfirm } from '../../../common';

export interface IProductStockOrderConfirmPayload extends ICorrelationPayload {
  products: IOrderProductConfirm[];
}
