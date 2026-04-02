import { ICorrelationPayload, IOrderProductConfirm } from '../../common';

// REVIEW-FIX: ARCH-001 — re-export IOrderProductConfirm from common for backward compatibility
export { IOrderProductConfirm } from '../../common';

export interface IOrderConfirmPayload extends ICorrelationPayload {
  id: number;
}

export interface IOrderConfirm extends IOrderConfirmPayload {
  products: IOrderProductConfirm[];
}
