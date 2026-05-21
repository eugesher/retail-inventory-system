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
  // wire today (ADR-008). Flipping it to include a correlationId would require a
  // coordinated change on the retail microservice's @MessagePattern handler.
  getOrderStatus(id: number): Promise<{ statusId: OrderStatusEnum } | null>;
}
