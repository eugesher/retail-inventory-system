import { OrderLineStatusEnum } from '@retail-inventory-system/contracts';
import { Entity } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IOrderLineProps {
  id: number | null;
  variantId: number;
  sku: string;
  nameSnapshot: string;
  quantity: number;
  cancelledQuantity?: number;
  unitPriceMinor: number;
  taxAmountMinor?: number;
  discountAmountMinor?: number;
  lineTotalMinor?: number;
  status?: OrderLineStatusEnum;
}

export class OrderLine extends Entity<number | null> {
  public readonly variantId: number;
  public readonly sku: string;
  public readonly nameSnapshot: string;
  public readonly quantity: number;
  public readonly unitPriceMinor: number;
  public readonly taxAmountMinor: number;
  public readonly discountAmountMinor: number;
  public readonly lineTotalMinor: number;
  private _status: OrderLineStatusEnum;
  private _cancelledQuantity: number;

  constructor(props: IOrderLineProps) {
    if (!Number.isInteger(props.variantId) || props.variantId <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_VARIANT_INVALID,
        `OrderLine.variantId must be a positive integer, got ${props.variantId}`,
      );
    }
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID,
        `OrderLine.quantity must be a positive integer, got ${props.quantity}`,
      );
    }
    const cancelledQuantity = props.cancelledQuantity ?? 0;
    if (
      !Number.isInteger(cancelledQuantity) ||
      cancelledQuantity < 0 ||
      cancelledQuantity > props.quantity
    ) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID,
        `OrderLine.cancelledQuantity must be an integer within [0, ${props.quantity}], got ${cancelledQuantity}`,
      );
    }
    if (typeof props.sku !== 'string' || props.sku.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_SKU_REQUIRED,
        'OrderLine.sku must be a non-empty string',
      );
    }
    if (typeof props.nameSnapshot !== 'string' || props.nameSnapshot.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_NAME_REQUIRED,
        'OrderLine.nameSnapshot must be a non-empty string',
      );
    }

    const taxAmountMinor = props.taxAmountMinor ?? 0;
    const discountAmountMinor = props.discountAmountMinor ?? 0;
    OrderLine.requireNonNegativeMoney(props.unitPriceMinor, 'unitPriceMinor');
    OrderLine.requireNonNegativeMoney(taxAmountMinor, 'taxAmountMinor');
    OrderLine.requireNonNegativeMoney(discountAmountMinor, 'discountAmountMinor');

    const expected = props.unitPriceMinor * props.quantity + taxAmountMinor - discountAmountMinor;
    if (props.lineTotalMinor !== undefined && props.lineTotalMinor !== expected) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_TOTAL_MISMATCH,
        `OrderLine.lineTotalMinor (${props.lineTotalMinor}) must equal unitPriceMinor × quantity + tax − discount (${expected})`,
      );
    }
    OrderLine.requireNonNegativeMoney(expected, 'lineTotalMinor');

    super(props.id);
    this.variantId = props.variantId;
    this.sku = props.sku;
    this.nameSnapshot = props.nameSnapshot;
    this.quantity = props.quantity;
    this.unitPriceMinor = props.unitPriceMinor;
    this.taxAmountMinor = taxAmountMinor;
    this.discountAmountMinor = discountAmountMinor;
    this.lineTotalMinor = expected;
    this._cancelledQuantity = cancelledQuantity;
    this._status = props.status ?? OrderLineStatusEnum.ALLOCATED;
  }

  public get status(): OrderLineStatusEnum {
    return this._status;
  }

  public get cancelledQuantity(): number {
    return this._cancelledQuantity;
  }

  public get activeQuantity(): number {
    return this.quantity - this._cancelledQuantity;
  }

  public cancelQuantity(units: number): void {
    if (!Number.isInteger(units) || units <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID,
        `OrderLine.cancelQuantity: units must be a positive integer, got ${units}`,
      );
    }
    if (units > this.activeQuantity) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
        `OrderLine ${this.id}: cannot cancel ${units} — only ${this.activeQuantity} of the ${this.quantity} ordered remain uncancelled`,
      );
    }
    this._cancelledQuantity += units;
    if (this.activeQuantity === 0) {
      this._status = OrderLineStatusEnum.CANCELLED;
    }
  }

  public markFulfillment(next: OrderLineStatusEnum): void {
    const target = OrderLine.fulfillmentRank(next);
    const current = OrderLine.fulfillmentRank(this._status);
    if (target === null || current === null) {
      throw new Error(
        `OrderLine.markFulfillment: ${next} is not a fulfillment-progress status (line ${this.id})`,
      );
    }
    if (target < current) {
      throw new Error(
        `OrderLine.markFulfillment: cannot move line ${this.id} backward from ${this._status} to ${next}`,
      );
    }
    this._status = next;
  }

  private static fulfillmentRank(status: OrderLineStatusEnum): number | null {
    switch (status) {
      case OrderLineStatusEnum.ALLOCATED:
        return 0;
      case OrderLineStatusEnum.PARTIALLY_SHIPPED:
        return 1;
      case OrderLineStatusEnum.SHIPPED:
        return 2;
      default:
        return null;
    }
  }

  private static requireNonNegativeMoney(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_MONEY_INVALID,
        `OrderLine.${field} must be a non-negative integer (minor units), got ${value}`,
      );
    }
  }
}
