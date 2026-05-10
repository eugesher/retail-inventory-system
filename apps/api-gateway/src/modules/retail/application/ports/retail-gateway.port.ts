import {
  OrderConfirmResponseDto,
  OrderCreateDto,
  OrderCreateResponseDto,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

export const RETAIL_GATEWAY_PORT = Symbol('RETAIL_GATEWAY_PORT');

export interface IRetailGatewayPort {
  createOrder(dto: OrderCreateDto, correlationId: string): Promise<OrderCreateResponseDto>;
  confirmOrder(id: number, correlationId: string): Promise<OrderConfirmResponseDto>;
  // No correlationId here — `RETAIL_ORDER_GET` carries only the numeric id on the
  // wire today (ADR-008). The gap is acknowledged in _carryover-05.md and is to
  // be revisited together with the publisher-port work in task-08/task-09.
  getOrderStatus(id: number): Promise<{ statusId: OrderStatusEnum } | null>;
}
