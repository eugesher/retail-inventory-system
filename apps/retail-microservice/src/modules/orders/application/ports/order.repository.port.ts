import {
  IOrderConfirm,
  IOrderProductConfirm,
  OrderConfirmResponseDto,
} from '@retail-inventory-system/contracts';

import { Order } from '../../domain';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

// Inbound port for the Order aggregate's persistence. Adapter is the
// TypeORM-backed `OrderTypeormRepository`; use cases and pipes never
// reference the concrete repository or the `order` / `order_product` /
// `customer` / `product` entities directly. The presentation-layer pipes
// (`OrderCreatePipe`, `OrderConfirmPipe`) reach into the port for the
// pre-RPC existence checks and line-item load — keeping `Repository<...>`
// confined to the adapter satisfies the boundary rule.
//
// `findOrderResponse` returns the full `OrderConfirmResponseDto` (joined
// status reference rows for `name` / `color`). It sits behind the port so
// the use case stays a thin coordinator — controllers and the e2e snapshots
// expect the reference-table fields verbatim, and constructing those at the
// use-case layer would require an extra round-trip per response.
export interface IOrderRepositoryPort {
  findById(id: number): Promise<Order | null>;
  findHeaderById(id: number): Promise<{ statusId: Order['statusId'] } | null>;
  findOrderResponse(id: number): Promise<OrderConfirmResponseDto | null>;
  // Returns the confirm-time view of an order: id + its line items (id,
  // productId, statusId). Used by `OrderConfirmPipe` to short-circuit a
  // confirm RPC with 404 before the use case runs.
  findConfirmableOrder(id: number): Promise<Omit<IOrderConfirm, 'correlationId'> | null>;
  // Existence check used by `OrderCreatePipe`. Returns true iff the
  // `customer` row exists.
  customerExists(customerId: number): Promise<boolean>;
  // Returns the subset of the given productIds that resolve to a `product`
  // row. Used by `OrderCreatePipe` to reject orders for unknown products.
  findExistingProductIds(productIds: number[]): Promise<number[]>;
  save(order: Order): Promise<Order>;
  confirmLines(payload: {
    orderId: number;
    newlyConfirmedProductIds: number[];
    shouldFlipHeaderToConfirmed: boolean;
    correlationId?: string;
  }): Promise<void>;
}

// Helper alias kept here so the pipes/use cases don't need to import the
// contracts package twice.
export type OrderConfirmableProduct = IOrderProductConfirm;
