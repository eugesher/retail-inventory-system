import {
  OrderFulfillmentStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderLine } from './order-line.model';
import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IOrderProps {
  id: number | null;
  orderNumber: string;
  customerId: string | null;
  currency: string;
  status?: OrderStatusEnum;
  paymentStatus?: OrderPaymentStatusEnum;
  fulfillmentStatus?: OrderFulfillmentStatusEnum;
  lines: OrderLine[];
  subtotalMinor: number;
  taxTotalMinor?: number;
  discountTotalMinor?: number;
  shippingTotalMinor?: number;
  grandTotalMinor: number;
  billingAddressId: string | null;
  shippingAddressId: string | null;
  sourceCartId: string | null;
  placedAt: Date | null;
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface IPlaceOrderInput {
  orderNumber: string;
  customerId: string | null;
  currency: string;
  lines: OrderLine[];
  billingAddressId: string | null;
  shippingAddressId: string | null;
  sourceCartId: string | null;
  placedAt: Date;
}

const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

export class Order extends AggregateRoot<number | null> {
  private readonly _orderNumber: string;
  private readonly _customerId: string | null;
  private readonly _currency: string;
  private _status: OrderStatusEnum;
  private _paymentStatus: OrderPaymentStatusEnum;
  private _fulfillmentStatus: OrderFulfillmentStatusEnum;
  private readonly _lines: OrderLine[];
  private readonly _subtotalMinor: number;
  private readonly _taxTotalMinor: number;
  private readonly _discountTotalMinor: number;
  private readonly _shippingTotalMinor: number;
  private readonly _grandTotalMinor: number;
  private readonly _billingAddressId: string | null;
  private readonly _shippingAddressId: string | null;
  private readonly _sourceCartId: string | null;
  private readonly _placedAt: Date | null;
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IOrderProps) {
    if (typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_CURRENCY_INVALID,
        `Order.currency must be a non-empty 3-letter code, got ${String(props.currency)}`,
      );
    }
    if (props.lines.length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NO_LINES,
        'Order must carry at least one line',
      );
    }

    const taxTotalMinor = props.taxTotalMinor ?? 0;
    const discountTotalMinor = props.discountTotalMinor ?? 0;
    const shippingTotalMinor = props.shippingTotalMinor ?? 0;
    Order.requireNonNegativeMoney(props.subtotalMinor, 'subtotalMinor');
    Order.requireNonNegativeMoney(taxTotalMinor, 'taxTotalMinor');
    Order.requireNonNegativeMoney(discountTotalMinor, 'discountTotalMinor');
    Order.requireNonNegativeMoney(shippingTotalMinor, 'shippingTotalMinor');
    Order.requireNonNegativeMoney(props.grandTotalMinor, 'grandTotalMinor');

    const lineSum = props.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    if (props.subtotalMinor !== lineSum) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_TOTAL_MISMATCH,
        `Order.subtotalMinor (${props.subtotalMinor}) must equal Σ line.lineTotalMinor (${lineSum})`,
      );
    }
    const expectedGrand =
      props.subtotalMinor + taxTotalMinor + shippingTotalMinor - discountTotalMinor;
    if (props.grandTotalMinor !== expectedGrand) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_TOTAL_MISMATCH,
        `Order.grandTotalMinor (${props.grandTotalMinor}) must equal subtotal + tax + shipping − discount (${expectedGrand})`,
      );
    }

    const version = props.version ?? 0;
    if (!Number.isInteger(version) || version < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_VERSION_INVALID,
        `Order.version must be a non-negative integer, got ${version}`,
      );
    }

    super(props.id);
    this._orderNumber = props.orderNumber;
    this._customerId = props.customerId;
    this._currency = props.currency;
    this._status = props.status ?? OrderStatusEnum.PENDING;
    this._paymentStatus = props.paymentStatus ?? OrderPaymentStatusEnum.NONE;
    this._fulfillmentStatus = props.fulfillmentStatus ?? OrderFulfillmentStatusEnum.UNFULFILLED;
    this._lines = props.lines;
    this._subtotalMinor = props.subtotalMinor;
    this._taxTotalMinor = taxTotalMinor;
    this._discountTotalMinor = discountTotalMinor;
    this._shippingTotalMinor = shippingTotalMinor;
    this._grandTotalMinor = props.grandTotalMinor;
    this._billingAddressId = props.billingAddressId;
    this._shippingAddressId = props.shippingAddressId;
    this._sourceCartId = props.sourceCartId;
    this._placedAt = props.placedAt;
    this._version = version;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static place(input: IPlaceOrderInput): Order {
    const subtotalMinor = input.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    return new Order({
      id: null,
      orderNumber: input.orderNumber,
      customerId: input.customerId,
      currency: input.currency,
      status: OrderStatusEnum.PENDING,
      paymentStatus: OrderPaymentStatusEnum.NONE,
      fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
      lines: input.lines,
      subtotalMinor,
      taxTotalMinor: 0,
      discountTotalMinor: 0,
      shippingTotalMinor: 0,
      grandTotalMinor: subtotalMinor,
      billingAddressId: input.billingAddressId,
      shippingAddressId: input.shippingAddressId,
      sourceCartId: input.sourceCartId,
      placedAt: input.placedAt,
      version: 0,
    });
  }

  public static reconstitute(props: IOrderProps): Order {
    return new Order(props);
  }

  public get orderNumber(): string {
    return this._orderNumber;
  }

  public get customerId(): string | null {
    return this._customerId;
  }

  public get currency(): string {
    return this._currency;
  }

  public get status(): OrderStatusEnum {
    return this._status;
  }

  public get paymentStatus(): OrderPaymentStatusEnum {
    return this._paymentStatus;
  }

  public get fulfillmentStatus(): OrderFulfillmentStatusEnum {
    return this._fulfillmentStatus;
  }

  public get lines(): readonly OrderLine[] {
    return this._lines;
  }

  public get subtotalMinor(): number {
    return this._subtotalMinor;
  }

  public get taxTotalMinor(): number {
    return this._taxTotalMinor;
  }

  public get discountTotalMinor(): number {
    return this._discountTotalMinor;
  }

  public get shippingTotalMinor(): number {
    return this._shippingTotalMinor;
  }

  public get grandTotalMinor(): number {
    return this._grandTotalMinor;
  }

  public get billingAddressId(): string | null {
    return this._billingAddressId;
  }

  public get shippingAddressId(): string | null {
    return this._shippingAddressId;
  }

  public get sourceCartId(): string | null {
    return this._sourceCartId;
  }

  public get placedAt(): Date | null {
    return this._placedAt;
  }

  public get version(): number {
    return this._version;
  }

  public markPaymentAuthorized(): void {
    if (this._paymentStatus !== OrderPaymentStatusEnum.NONE) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order.markPaymentAuthorized: can only authorize a payment in 'none' (current: ${this._paymentStatus})`,
      );
    }
    this._paymentStatus = OrderPaymentStatusEnum.AUTHORIZED;
    this.bumpVersion();
  }

  public markPaymentFailed(): void {
    if (this._paymentStatus !== OrderPaymentStatusEnum.NONE) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order.markPaymentFailed: only an unauthorized payment can fail (current: ${this._paymentStatus})`,
      );
    }
    this._paymentStatus = OrderPaymentStatusEnum.FAILED;
    this.bumpVersion();
  }

  public markPaymentCaptured(): void {
    if (this._paymentStatus !== OrderPaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order.markPaymentCaptured: can only capture an authorized payment (current: ${this._paymentStatus})`,
      );
    }
    this._paymentStatus = OrderPaymentStatusEnum.CAPTURED;
    this.bumpVersion();
  }

  public advanceFulfillment(next: OrderFulfillmentStatusEnum): void {
    if (Order.fulfillmentRank(next) < Order.fulfillmentRank(this._fulfillmentStatus)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION,
        `Order.advanceFulfillment: cannot move the fulfillment axis backward from ${this._fulfillmentStatus} to ${next}`,
      );
    }
    this._fulfillmentStatus = next;
    this.bumpVersion();
  }

  public cancel(): void {
    if (this._status !== OrderStatusEnum.PENDING && this._status !== OrderStatusEnum.CONFIRMED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
        `Order.cancel: can only cancel a pending or confirmed order (current: ${this._status})`,
      );
    }
    this._status = OrderStatusEnum.CANCELLED;
    this.bumpVersion();
  }

  public cancelLineQuantity(orderLineId: number, units: number): OrderLine {
    const line = this._lines.find((candidate) => candidate.id === orderLineId);
    if (!line) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
        `Order line ${orderLineId} does not belong to order ${this.id}`,
      );
    }
    line.cancelQuantity(units);
    this.bumpVersion();
    return line;
  }

  public markDelivered(): void {
    if (this._status === OrderStatusEnum.CANCELLED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION,
        'Order.markDelivered: a cancelled order cannot be delivered',
      );
    }
    if (
      this._fulfillmentStatus !== OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED &&
      this._fulfillmentStatus !== OrderFulfillmentStatusEnum.SHIPPED
    ) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION,
        `Order.markDelivered: can only deliver a shipped order (fulfillment axis: ${this._fulfillmentStatus})`,
      );
    }
    this._status = OrderStatusEnum.DELIVERED;
    this._fulfillmentStatus = OrderFulfillmentStatusEnum.DELIVERED;
    this.bumpVersion();
  }

  private static fulfillmentRank(status: OrderFulfillmentStatusEnum): number {
    switch (status) {
      case OrderFulfillmentStatusEnum.UNFULFILLED:
        return 0;
      case OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED:
        return 1;
      case OrderFulfillmentStatusEnum.SHIPPED:
        return 2;
      case OrderFulfillmentStatusEnum.DELIVERED:
        return 3;
    }
  }

  private static requireNonNegativeMoney(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_MONEY_INVALID,
        `Order.${field} must be a non-negative integer (minor units), got ${value}`,
      );
    }
  }

  private bumpVersion(): void {
    this._version += 1;
  }
}
