import { IOrderProductConfirm, OrderConfirmResponseDto } from '@retail-inventory-system/contracts';

import {
  CustomerRef,
  Order,
  OrderCancelledEvent,
  OrderConfirmedEvent,
  OrderCreatedEvent,
  OrderProduct,
  OrderProductStatusVO,
  OrderStatusVO,
} from '../../../domain';
import {
  IInventoryConfirmGatewayPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
} from '../../ports';

// In-memory port doubles for the orders use-case specs. Pure TypeScript — no
// jest globals, so the file is safe to include in production builds when
// `tsconfig.app.json`'s `exclude` only filters `*.spec.ts` (see
// _carryover-08 §9 #5).

let _nextOrderId = 1000;
let _nextOrderProductId = 9000;

// Builds an in-memory Order with persisted ids — mimics what the repository
// hands back after an INSERT. Specs that exercise the create-path should
// keep the id assignment in the repo double (so the use case observes the
// real assign-after-save flow).
export const buildPersistedOrder = (props: {
  id?: number;
  customerId?: number;
  lines: { id?: number; productId: number; statusId?: 'pending' | 'confirmed' }[];
  status?: 'pending' | 'confirmed';
}): Order => {
  const products = props.lines.map(
    (line) =>
      new OrderProduct({
        id: line.id ?? _nextOrderProductId++,
        productId: line.productId,
        status:
          line.statusId === 'confirmed'
            ? OrderProductStatusVO.CONFIRMED
            : OrderProductStatusVO.PENDING,
      }),
  );
  return Order.reconstitute({
    id: props.id ?? _nextOrderId++,
    customer: new CustomerRef({ id: props.customerId ?? 1 }),
    products,
    status: props.status === 'confirmed' ? OrderStatusVO.CONFIRMED : OrderStatusVO.PENDING,
  });
};

export class InMemoryOrderRepository implements IOrderRepositoryPort {
  public readonly stored = new Map<number, Order>();
  public readonly savedAggregates: Order[] = [];
  public readonly confirmLineCalls: {
    orderId: number;
    newlyConfirmedProductIds: number[];
    shouldFlipHeaderToConfirmed: boolean;
    correlationId?: string;
  }[] = [];

  public seed(order: Order): void {
    if (order.id === null) {
      throw new Error('InMemoryOrderRepository.seed: aggregate must be persisted (id !== null)');
    }
    this.stored.set(order.id, order);
  }

  public findById(id: number): Promise<Order | null> {
    return Promise.resolve(this.stored.get(id) ?? null);
  }

  public findHeaderById(id: number): Promise<{ statusId: Order['statusId'] } | null> {
    const order = this.stored.get(id);
    return Promise.resolve(order ? { statusId: order.statusId } : null);
  }

  public findConfirmableOrder(id: number): Promise<{
    id: number;
    products: IOrderProductConfirm[];
  } | null> {
    const order = this.stored.get(id);
    if (order?.id == null) return Promise.resolve(null);
    return Promise.resolve({
      id: order.id,
      products: order.products
        .filter((line): line is OrderProduct & { id: number } => line.id !== null)
        .map((line) => ({
          id: line.id,
          productId: line.productId,
          statusId: line.statusId,
        })),
    });
  }

  public customerExists(customerId: number): Promise<boolean> {
    void customerId;
    return Promise.resolve(true);
  }

  public findExistingProductIds(productIds: number[]): Promise<number[]> {
    return Promise.resolve([...productIds]);
  }

  public findOrderResponse(id: number): Promise<OrderConfirmResponseDto | null> {
    const order = this.stored.get(id);
    if (!order) return Promise.resolve(null);
    return Promise.resolve({
      id,
      status: { id: order.status.value, name: '', color: '' },
      products: order.products.map((line) => ({
        id: line.id ?? 0,
        productId: line.productId,
        status: { id: line.status.value, name: '', color: '' },
      })),
    });
  }

  public save(order: Order): Promise<Order> {
    // Mimic repo behavior: an unpersisted aggregate (id === null) gets a
    // fresh id; line items also get ids. We hand back a `reconstitute`d copy
    // with the assigned ids — the use case treats this as authoritative.
    const persisted = buildPersistedOrder({
      id: order.id ?? _nextOrderId++,
      customerId: order.customer.id,
      lines: order.products.map((p) => ({
        id: p.id ?? _nextOrderProductId++,
        productId: p.productId,
        statusId: p.isConfirmed() ? 'confirmed' : 'pending',
      })),
      status: order.status.isConfirmed() ? 'confirmed' : 'pending',
    });
    this.stored.set(persisted.id!, persisted);
    this.savedAggregates.push(persisted);
    return Promise.resolve(persisted);
  }

  public confirmLines(payload: {
    orderId: number;
    newlyConfirmedProductIds: number[];
    shouldFlipHeaderToConfirmed: boolean;
    correlationId?: string;
  }): Promise<void> {
    this.confirmLineCalls.push(payload);
    const order = this.stored.get(payload.orderId);
    if (!order) return Promise.resolve();
    const confirmedSet = new Set(payload.newlyConfirmedProductIds);
    const products = order.products.map(
      (line) =>
        new OrderProduct({
          id: line.id,
          productId: line.productId,
          status:
            line.isConfirmed() || (line.id !== null && confirmedSet.has(line.id))
              ? OrderProductStatusVO.CONFIRMED
              : OrderProductStatusVO.PENDING,
        }),
    );
    const updated = Order.reconstitute({
      id: order.id,
      customer: order.customer,
      products,
      status: payload.shouldFlipHeaderToConfirmed ? OrderStatusVO.CONFIRMED : order.status,
    });
    this.stored.set(payload.orderId, updated);
    return Promise.resolve();
  }
}

export class InMemoryInventoryConfirmGateway implements IInventoryConfirmGatewayPort {
  public readonly calls: { products: IOrderProductConfirm[]; correlationId: string }[] = [];
  public response: number[] | (() => number[] | Promise<number[]>) = [];
  public shouldThrow: Error | null = null;

  public reserveOrderStock(payload: {
    products: IOrderProductConfirm[];
    correlationId: string;
  }): Promise<number[]> {
    this.calls.push(payload);
    if (this.shouldThrow) {
      return Promise.reject(this.shouldThrow);
    }
    if (typeof this.response === 'function') {
      return Promise.resolve(this.response());
    }
    return Promise.resolve(this.response);
  }
}

export class InMemoryOrderEventsPublisher implements IOrderEventsPublisherPort {
  public readonly created: { event: OrderCreatedEvent; correlationId?: string }[] = [];
  public readonly confirmed: { event: OrderConfirmedEvent; correlationId?: string }[] = [];
  public readonly cancelled: { event: OrderCancelledEvent; correlationId?: string }[] = [];

  public publishOrderCreated(event: OrderCreatedEvent, correlationId?: string): Promise<void> {
    this.created.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishOrderConfirmed(event: OrderConfirmedEvent, correlationId?: string): Promise<void> {
    this.confirmed.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishOrderCancelled(event: OrderCancelledEvent, correlationId?: string): Promise<void> {
    this.cancelled.push({ event, correlationId });
    return Promise.resolve();
  }
}
