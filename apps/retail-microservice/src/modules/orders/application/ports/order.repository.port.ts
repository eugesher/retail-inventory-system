import {
  IOrderConfirm,
  IOrderProductConfirm,
  OrderConfirmResponseDto,
} from '@retail-inventory-system/contracts';

import { Order } from '../../domain';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

// `findOrderResponse` returns the joined reference-table fields (`name`,
// `color`) verbatim — e2e snapshots assert on those, and assembling them at
// the use-case layer would force an extra round-trip per response.
export interface IOrderRepositoryPort {
  findById(id: number): Promise<Order | null>;
  findHeaderById(id: number): Promise<{ statusId: Order['statusId'] } | null>;
  findOrderResponse(id: number): Promise<OrderConfirmResponseDto | null>;
  findConfirmableOrder(id: number): Promise<Omit<IOrderConfirm, 'correlationId'> | null>;
  save(order: Order): Promise<Order>;
  confirmLines(payload: {
    orderId: number;
    newlyConfirmedProductIds: number[];
    shouldFlipHeaderToConfirmed: boolean;
    correlationId?: string;
  }): Promise<void>;
}

export type OrderConfirmableProduct = IOrderProductConfirm;
