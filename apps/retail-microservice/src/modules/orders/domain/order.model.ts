import { OrderStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderCancelledEvent, OrderConfirmedEvent } from './events';
import { OrderProduct } from './order-product.model';
import { OrderProductStatusVO } from './order-product-status.value-object';
import { OrderStatusVO } from './order-status.value-object';

interface IOrderProps {
  id: number | null;
  products: OrderProduct[];
  status: OrderStatusVO;
}

export interface IOrderConfirmationResult {
  someProductsConfirmed: boolean;
  allProductsConfirmed: boolean;
  skipUpdate: boolean;
  newlyConfirmedProductIds: number[];
}

export class Order extends AggregateRoot<number | null> {
  private _products: OrderProduct[];
  private _status: OrderStatusVO;

  private constructor(props: IOrderProps) {
    super(props.id);
    this._products = props.products;
    this._status = props.status;
  }

  // Expands per-quantity into one line per unit — `order_product` has no
  // `quantity` column, so each unit gets its own row.
  public static create(props: { lines: { productId: number; quantity: number }[] }): Order {
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
      products,
      status: OrderStatusVO.PENDING,
    });
  }

  public static reconstitute(props: IOrderProps): Order {
    return new Order(props);
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

  // `confirmedOrderProductIds` is the subset of line ids for which the
  // inventory side actually reserved stock — not the request set.
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
          lines: this._products
            .filter((line): line is OrderProduct & { id: number } => line.id !== null)
            .map((line) => ({ orderProductId: line.id, productId: line.productId })),
        }),
      );
    }

    return { someProductsConfirmed, allProductsConfirmed, skipUpdate, newlyConfirmedProductIds };
  }

  // No producer wires this today; the cancel-after-confirm pathway is a
  // separate refund flow, hence the CONFIRMED guard.
  public cancel(reason?: string): void {
    if (this._status.isConfirmed()) {
      throw new Error('Order.cancel: cannot cancel an already-confirmed order');
    }
    this.addDomainEvent(
      new OrderCancelledEvent({
        orderId: this.id ?? 0,
        reason,
      }),
    );
  }
}
