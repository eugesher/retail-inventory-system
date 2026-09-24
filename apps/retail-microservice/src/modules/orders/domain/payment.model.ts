import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IPaymentProps {
  id: number | null;
  orderId: number;
  amountMinor: number;
  currency: string;
  method: string;
  status: PaymentStatusEnum;
  gatewayReference: string;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  flaggedForRefund?: boolean;
  refundedAmountMinor?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface IPaymentAuthorizedInput {
  orderId: number;
  amountMinor: number;
  currency: string;
  method: string;
  gatewayReference: string;
  authorizedAt: Date;
}

export class Payment extends AggregateRoot<number | null> {
  private readonly _orderId: number;
  private readonly _amountMinor: number;
  private readonly _currency: string;
  private readonly _method: string;
  private _status: PaymentStatusEnum;
  private readonly _gatewayReference: string;
  private readonly _authorizedAt: Date | null;
  private _capturedAt: Date | null;
  private _flaggedForRefund: boolean;
  private _refundedAmountMinor: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IPaymentProps) {
    if (!Number.isInteger(props.orderId) || props.orderId <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_ORDER_ID_INVALID,
        `Payment.orderId must be a positive integer, got ${props.orderId}`,
      );
    }
    if (!Number.isInteger(props.amountMinor) || props.amountMinor < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_AMOUNT_INVALID,
        `Payment.amountMinor must be a non-negative integer (minor units), got ${props.amountMinor}`,
      );
    }
    const refundedAmountMinor = props.refundedAmountMinor ?? 0;
    if (!Number.isInteger(refundedAmountMinor) || refundedAmountMinor < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_AMOUNT_INVALID,
        `Payment.refundedAmountMinor must be a non-negative integer (minor units), got ${refundedAmountMinor}`,
      );
    }
    Payment.requireNonEmpty(
      props.currency,
      OrderErrorCodeEnum.PAYMENT_CURRENCY_REQUIRED,
      'currency',
    );
    Payment.requireNonEmpty(props.method, OrderErrorCodeEnum.PAYMENT_METHOD_REQUIRED, 'method');
    Payment.requireNonEmpty(
      props.gatewayReference,
      OrderErrorCodeEnum.PAYMENT_GATEWAY_REFERENCE_REQUIRED,
      'gatewayReference',
    );

    super(props.id);
    this._orderId = props.orderId;
    this._amountMinor = props.amountMinor;
    this._currency = props.currency;
    this._method = props.method;
    this._status = props.status;
    this._gatewayReference = props.gatewayReference;
    this._authorizedAt = props.authorizedAt;
    this._capturedAt = props.capturedAt;
    this._flaggedForRefund = props.flaggedForRefund ?? false;
    this._refundedAmountMinor = refundedAmountMinor;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static authorized(input: IPaymentAuthorizedInput): Payment {
    return new Payment({
      id: null,
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      method: input.method,
      status: PaymentStatusEnum.AUTHORIZED,
      gatewayReference: input.gatewayReference,
      authorizedAt: input.authorizedAt,
      capturedAt: null,
      flaggedForRefund: false,
      refundedAmountMinor: 0,
    });
  }

  public static reconstitute(props: IPaymentProps): Payment {
    return new Payment(props);
  }

  public get orderId(): number {
    return this._orderId;
  }

  public get amountMinor(): number {
    return this._amountMinor;
  }

  public get currency(): string {
    return this._currency;
  }

  public get method(): string {
    return this._method;
  }

  public get status(): PaymentStatusEnum {
    return this._status;
  }

  public get gatewayReference(): string {
    return this._gatewayReference;
  }

  public get authorizedAt(): Date | null {
    return this._authorizedAt;
  }

  public get capturedAt(): Date | null {
    return this._capturedAt;
  }

  public get flaggedForRefund(): boolean {
    return this._flaggedForRefund;
  }

  public get refundedAmountMinor(): number {
    return this._refundedAmountMinor;
  }

  public beginCapture(): void {
    if (this._status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.beginCapture: can only claim an authorized payment (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.CAPTURING;
  }

  public completeCapture(at: Date): void {
    if (this._status !== PaymentStatusEnum.CAPTURING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.completeCapture: can only complete a claimed capture (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.CAPTURED;
    this._capturedAt = at;
  }

  public releaseCapture(): void {
    if (this._status !== PaymentStatusEnum.CAPTURING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.releaseCapture: can only release a claimed capture (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.AUTHORIZED;
  }

  public void(): void {
    if (this._status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.void: can only void an authorized payment (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.VOIDED;
  }

  public flagForRefund(): void {
    this._flaggedForRefund = true;
  }

  public refund(amountMinor: number): void {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new Error(
        `Payment.refund: amountMinor must be a positive integer (minor units), got ${amountMinor}`,
      );
    }
    if (this._status !== PaymentStatusEnum.CAPTURED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.refund: can only refund a captured payment (current: ${this._status})`,
      );
    }
    if (this._refundedAmountMinor + amountMinor > this._amountMinor) {
      throw new Error(
        `Payment.refund: refund of ${amountMinor} would exceed the refundable remainder ` +
          `(${this._amountMinor - this._refundedAmountMinor})`,
      );
    }

    this._refundedAmountMinor += amountMinor;
    if (this._refundedAmountMinor === this._amountMinor) {
      this._status = PaymentStatusEnum.REFUNDED;
      this._flaggedForRefund = false;
    }
  }

  private static requireNonEmpty(value: string, code: OrderErrorCodeEnum, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new OrderDomainException(code, `Payment.${field} must be a non-empty string`);
    }
  }
}
