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

// Input to the `open` factory — the construction path from Issue Refund. `status` /
// `gatewayReference` / `issuedAt` are set by the factory (PENDING / null / null), not
// supplied by the caller.
export interface IOpenRefundInput {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  currency: string;
  reason: string;
}

// `Refund` is the record of a single gateway refund interaction against a captured
// `payment` — its own aggregate root, **not** a child of `Order` or `Payment`. It
// lives inside the `orders/` module (a sibling of `Payment` / `Address` /
// `Fulfillment`) because every refund operation **mutates `Payment`** — it walks the
// payment status and increments `refunded_amount_minor` — and `Payment` lives here
// (docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md). Placing it
// elsewhere would re-import the orders context across a module boundary, the very
// coupling ADR-028 §4 avoids.
//
// A `Refund` is **distinct from a `ReturnRequest`**: a refund must be able to exist
// with no return behind it — a chargeback, a goodwill credit, a partial price
// adjustment, or a refund Cancel Order issues on an order that never shipped. A return
// that closes with money owed *triggers* a refund rather than *being* one.
//
// `gatewayReference` is the **opaque token** the gateway returns when the refund
// issues (a real adapter echoes a processor's refund id; the in-process fake returns a
// deterministic stand-in) — retail stores it but never parses it, and it stays null
// while `pending`. `amountMinor` is an integer count of minor units (cents), never a
// float, and is **strictly positive** (a zero/negative refund is meaningless — unlike
// `Payment.amountMinor`, which allows 0 for a free order). The id is the auto-increment
// BIGINT assigned by persistence (`null` until then). The aggregate records **no**
// domain events — the Issue Refund use case emits `retail.refund.issued` / `.failed`
// after persistence (a later capability).
//
// The **amount ≤ `Payment.amountMinor − Payment.refundedAmountMinor`** ceiling (a
// refund can't exceed what is left to refund) is **NOT** enforced here — the model
// cannot see `Payment`. The Issue Refund use case enforces it
// (`REFUND_EXCEEDS_REFUNDABLE`, a later capability). The model enforces only its own
// shape: a positive amount, a non-empty reason, and legal status transitions.
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
    // `orderId` / `paymentId` are positive-integer references the orders module already
    // validates on `Payment`; reuse the module's shared id-invalid code (the
    // one-throwable-per-module convention — these are not refund-specific business
    // rules, unlike the amount/reason guards below).
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
    // A refund must move a **strictly positive** amount — distinct from
    // `Payment.amountMinor` (which allows 0), so it gets its own code.
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

  // The construction path from Issue Refund: opens the refund `PENDING` with no
  // gateway reference and no issue stamp (both set once the gateway answers). `id` is
  // null until persistence assigns the BIGINT.
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

  // Rebuilds a persisted refund from storage (any status). Records no events.
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

  // `PENDING → ISSUED`: the gateway refund succeeded, so stamp the opaque
  // `gatewayReference` it returned and the `issuedAt` moment. Rejects any non-`pending`
  // start (a double-issue, or issuing a failed refund) with
  // `REFUND_INVALID_STATUS_TRANSITION` (409).
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

  // `PENDING → FAILED` (terminal): the gateway declined the refund. Unreachable with
  // the always-succeed fake gateway, but modeled so a real decline has a home (the
  // `ORDER_PAYMENT_NOT_APPROVED` precedent). Rejects any non-`pending` start with
  // `REFUND_INVALID_STATUS_TRANSITION` (409).
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
