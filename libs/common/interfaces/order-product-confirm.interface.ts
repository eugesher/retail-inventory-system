// REVIEW-FIX: ARCH-001 — shared interface consumed by both retail and inventory libs
import { OrderProductStatusEnum } from '../enums';

export interface IOrderProductConfirm {
  id: number;
  productId: number;
  statusId: OrderProductStatusEnum;
}
