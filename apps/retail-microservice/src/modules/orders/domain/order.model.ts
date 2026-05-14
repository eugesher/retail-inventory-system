import { OrderStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CustomerRef } from './customer.model';
import { OrderCancelledEvent, OrderConfirmedEvent } from './events';
import { OrderProduct } from './order-product.model';
import { OrderProductStatusVO } from './order-product-status.value-object';
import { OrderStatusVO } from './order-status.value-object';

interface IOrderProps {
  id: number | null;
  customer: CustomerRef;
  products: OrderProduct[];
  status: OrderStatusVO;
}

// Result of `Order.applyInventoryConfirmation` — replaces the legacy
// `OrderConfirmDomain` state-transition computer. The legacy class lived as
// a standalone helper because the service layer needed the three flags
// simultaneously; today the aggregate decides transitions internally and
// hands the use case just enough to drive persistence.
export interface IOrderConfirmationResult {
  someProductsConfirmed: boolean;
  allProductsConfirmed: boolean;
  skipUpdate: boolean;
  newlyConfirmedProductIds: number[];
}

// Order aggregate root. Invariants enforced here:
//   - line items array is non-empty (an empty order cannot exist)
//   - `confirm()` is rejected when the header status is already CONFIRMED
//   - line-item statuses only ever transition PENDING → CONFIRMED
//
// The aggregate is the sole authority on "which line ids got newly
// confirmed?" — that question used to live in the standalone
// `OrderConfirmDomain` class. Folding it in keeps state transitions inside
// the boundary and lets the use case stay framework-thin.
//
// Create-path events (`retail.order.created`) are constructed by the use
// case after persistence assigns the aggregate id — the aggregate records
// only confirm/cancel events, which fire on transitions that always occur
// against an already-persisted aggregate.
export class Order extends AggregateRoot<number | null> {
  private _customer: CustomerRef;
  private _products: OrderProduct[];
  private _status: OrderStatusVO;

  private constructor(props: IOrderProps) {
    super(props.id);
    this._customer = props.customer;
    this._products = props.products;
    this._status = props.status;
  }

  // Factory for the create path. Expands per-quantity into one line per unit
  // (the legacy invariant — the persistence model has no `quantity` column on
  // `order_product`).
  public static create(props: {
    customer: CustomerRef;
    lines: { productId: number; quantity: number }[];
  }): Order {
    if (!props.lines.length) {
      throw new Error('Order.create: cannot create an order with no line items');
    }

    const products: OrderProduct[] = [];
    for (const line of props.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error(`Order.create: quantity must be a positive integer, got ${line.quantity}`);
      }
      for (let i = 0; i < line.quantity; i++) {
        products.push(
          new OrderProduct({
            id: null,
            productId: line.productId,
            status: OrderProductStatusVO.PENDING,
          }),
        );
      }
    }

    return new Order({
      id: null,
      customer: props.customer,
      products,
      status: OrderStatusVO.PENDING,
    });
  }

  // Reconstitutes an aggregate from persisted state. No domain event is
  // recorded — repositories use this on read-back paths.
  public static reconstitute(props: IOrderProps): Order {
    return new Order(props);
  }

  public get customer(): CustomerRef {
    return this._customer;
  }

  public get products(): readonly OrderProduct[] {
    return this._products;
  }

  public get status(): OrderStatusVO {
    return this._status;
  }

  public get statusId(): OrderStatusEnum {
    return this._status.value;
  }

  // Apply the result of an inventory `order.confirm` reservation: the
  // inventory side returns the subset of `OrderProduct.id`s for which stock
  // was successfully reserved. The aggregate decides which lines transition,
  // whether the header should flip to CONFIRMED, and records the
  // `OrderConfirmed` event when applicable. Returns the legacy
  // `someProductsConfirmed / allProductsConfirmed / skipUpdate` flags + the
  // newly-confirmed line ids so the persistence adapter can write the
  // minimum set of UPDATEs.
  public applyInventoryConfirmation(confirmedOrderProductIds: number[]): IOrderConfirmationResult {
    if (this._status.isConfirmed()) {
      throw new Error('Order.applyInventoryConfirmation: order is already confirmed');
    }

    const confirmedSet = new Set(confirmedOrderProductIds);
    const newlyConfirmedProductIds: number[] = [];

    for (const line of this._products) {
      if (line.id !== null && confirmedSet.has(line.id) && !line.isConfirmed()) {
        line.confirm();
        newlyConfirmedProductIds.push(line.id);
      }
    }

    const someProductsConfirmed = newlyConfirmedProductIds.length > 0;
    const allProductsConfirmed =
      this._products.length > 0 && this._products.every((line) => line.isConfirmed());
    const skipUpdate = !someProductsConfirmed && !allProductsConfirmed;

    if (allProductsConfirmed) {
      this._status = OrderStatusVO.CONFIRMED;
      this.addDomainEvent(
        new OrderConfirmedEvent({
          orderId: this.id ?? 0,
          customerId: this._customer.id,
          lines: this._products
            .filter((line): line is OrderProduct & { id: number } => line.id !== null)
            .map((line) => ({ orderProductId: line.id, productId: line.productId })),
        }),
      );
    }

    return { someProductsConfirmed, allProductsConfirmed, skipUpdate, newlyConfirmedProductIds };
  }

  // Reserved for a future cancel flow. Not exercised today; included so the
  // event/state contract is documented in code. Disallowed once the order is
  // CONFIRMED; the cancel-after-confirm pathway is a separate refund flow.
  public cancel(reason?: string): void {
    if (this._status.isConfirmed()) {
      throw new Error('Order.cancel: cannot cancel an already-confirmed order');
    }
    this.addDomainEvent(
      new OrderCancelledEvent({
        orderId: this.id ?? 0,
        customerId: this._customer.id,
        reason,
      }),
    );
  }
}
