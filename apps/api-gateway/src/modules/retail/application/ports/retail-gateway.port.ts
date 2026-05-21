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
  // `RETAIL_ORDER_GET` carries only the numeric id on the wire (ADR-008);
  // adding a correlationId would require a coordinated microservice change.
  getOrderStatus(id: number): Promise<{ statusId: OrderStatusEnum } | null>;
}
