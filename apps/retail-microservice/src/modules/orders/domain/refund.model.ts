import { RefundStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IRefundProps {
  id: number | null;
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  status: RefundStatusEnum;
  reason: string;
  gatewayReference: string | null;
  issuedAt: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface IOpenRefundInput {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  reason: string;
}

export class Refund extends AggregateRoot<number | null> {
  private readonly _orderId: number;
  private readonly _paymentId: number;
  private readonly _amountMinor: number;
  private readonly _currency: string;
  private _status: RefundStatusEnum;
  private readonly _reason: string;
  private _gatewayReference: string | null;
  private _issuedAt: Date | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IRefundProps) {
    if (!Number.isInteger(props.orderId) || props.orderId <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_ORDER_ID_INVALID,
        `Refund.orderId must be a positive integer, got ${props.orderId}`,
      );
    }
    if (!Number.isInteger(props.paymentId) || props.paymentId <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_ORDER_ID_INVALID,
        `Refund.paymentId must be a positive integer, got ${props.paymentId}`,
      );
    }
    if (!Number.isInteger(props.amountMinor) || props.amountMinor <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_AMOUNT_INVALID,
        `Refund.amountMinor must be a positive integer (minor units), got ${props.amountMinor}`,
      );
    }
    if (typeof props.currency !== 'string' || props.currency.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_CURRENCY_REQUIRED,
        'Refund.currency must be a non-empty string',
      );
    }
    if (typeof props.reason !== 'string' || props.reason.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_REASON_REQUIRED,
        'Refund.reason must be a non-empty string',
      );
    }

    super(props.id);
    this._orderId = props.orderId;
    this._paymentId = props.paymentId;
    this._amountMinor = props.amountMinor;
    this._currency = props.currency;
    this._status = props.status;
    this._reason = props.reason;
    this._gatewayReference = props.gatewayReference;
    this._issuedAt = props.issuedAt;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static open(input: IOpenRefundInput): Refund {
    return new Refund({
      id: null,
      orderId: input.orderId,
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: RefundStatusEnum.PENDING,
      reason: input.reason,
      gatewayReference: null,
      issuedAt: null,
    });
  }

  public static reconstitute(props: IRefundProps): Refund {
    return new Refund(props);
  }

  public get orderId(): number {
    return this._orderId;
  }

  public get paymentId(): number {
    return this._paymentId;
  }

  public get amountMinor(): number {
    return this._amountMinor;
  }

  public get currency(): string {
    return this._currency;
  }

  public get status(): RefundStatusEnum {
    return this._status;
  }

  public get reason(): string {
    return this._reason;
  }

  public get gatewayReference(): string | null {
    return this._gatewayReference;
  }

  public get issuedAt(): Date | null {
    return this._issuedAt;
  }

  public markIssued(input: { gatewayReference: string; issuedAt: Date }): void {
    if (this._status !== RefundStatusEnum.PENDING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_INVALID_STATUS_TRANSITION,
        `Refund.markIssued: can only issue a pending refund (current: ${this._status})`,
      );
    }
    this._status = RefundStatusEnum.ISSUED;
    this._gatewayReference = input.gatewayReference;
    this._issuedAt = input.issuedAt;
  }

  public markFailed(): void {
    if (this._status !== RefundStatusEnum.PENDING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.REFUND_INVALID_STATUS_TRANSITION,
        `Refund.markFailed: can only fail a pending refund (current: ${this._status})`,
      );
    }
    this._status = RefundStatusEnum.FAILED;
  }
}
