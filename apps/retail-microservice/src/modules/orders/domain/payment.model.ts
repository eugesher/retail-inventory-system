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
  // Set by Cancel Order on a captured payment (a later capability) to mark that a
  // refund is owed; a refund capability consumes it. Optional on the load path and
  // defaults `false` — a freshly authorized payment is never flagged.
  flaggedForRefund?: boolean;
  // Cumulative refunded total in minor units; the refund operation increments it and
  // the partial-vs-full decision reads it against `amountMinor`. Optional on the load
  // path and defaults `0` — a freshly authorized payment has refunded nothing.
  refundedAmountMinor?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the `authorized` factory — the construction path from a successful
// gateway authorize. `status` / `capturedAt` are set by the factory, not supplied.
export interface IPaymentAuthorizedInput {
  orderId: number;
  amountMinor: number;
  currency: string;
  method: string;
  gatewayReference: string;
  authorizedAt: Date;
}

// `Payment` is the record of a single gateway interaction for an order — its own
// aggregate root, **not** a child of `Order` (it has an independent lifecycle: it is
// created at authorize-on-place and later captured, while the order header tracks
// the same progress on its orthogonal payment *axis*). It lives inside the `orders/`
// module because every payment operation touches the `Order` aggregate (ADR-028 §4),
// not in a standalone module.
//
// `method` and `gatewayReference` are **opaque tokens** the gateway returns (a real
// processor's card/charge ids; the in-process fake returns deterministic
// stand-ins) — retail stores them but never parses them. `amountMinor` is an integer
// count of minor units (cents), never a float.
//
// A payment row only ever exists because an authorize succeeded, so its earliest
// state is `AUTHORIZED` — there is no `NONE` (that member lives only on the order's
// payment *axis*, for the pre-payment window). The id is the auto-increment BIGINT
// assigned by persistence (`null` until then). The aggregate records no domain
// events; the order's place / capture use cases own the wire events (later
// capabilities), never the payment domain.
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

  // The construction path from a successful authorize: opens the payment
  // `AUTHORIZED` with the gateway's opaque `method` / `gatewayReference`, stamps
  // `authorizedAt`, and leaves `capturedAt` null until an explicit capture. `id` is
  // null until persistence assigns the BIGINT.
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

  // Rebuilds a persisted payment from storage (any status). Records no events.
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

  // True once Cancel Order flags a captured payment as owing a refund (a later
  // capability writes it). `false` for every freshly authorized payment — the
  // mutator that sets it ships with its consumer, not here.
  public get flaggedForRefund(): boolean {
    return this._flaggedForRefund;
  }

  // The cumulative amount refunded against this payment, in minor units. `0` for
  // every freshly authorized payment — the `refund()` mutator that increments it
  // ships with its consumer (the issue-refund capability), not here. The column +
  // field + getter ship now so no later schema migration is needed (the
  // `flagged_for_refund`-ships-now precedent, ADR-028 §6).
  public get refundedAmountMinor(): number {
    return this._refundedAmountMinor;
  }

  // The **only** mutation: `AUTHORIZED → CAPTURED`, stamping `capturedAt`. Rejects
  // any non-`authorized` start (double-capture or capture of a voided/failed
  // payment). Void / refund / fail land with later capabilities — deliberately
  // absent here (they would be dead, untested transitions in this chain).
  public capture(at: Date): void {
    if (this._status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.capture: can only capture an authorized payment (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.CAPTURED;
    this._capturedAt = at;
  }

  // `AUTHORIZED → VOIDED`. Driven by Cancel Order when it cancels an order whose
  // payment was authorized-but-not-captured: voiding releases the held authorization so
  // no money is ever taken. Rejects any non-`authorized` start (a captured payment is
  // flagged for refund instead — `flagForRefund` — and a voided/failed one is already
  // terminal) with `PAYMENT_INVALID_STATUS_TRANSITION` (409). The in-process fake
  // gateway has no `void` call (it never reserved real funds); a real gateway would
  // void the authorization here — out of scope for this capability.
  public void(): void {
    if (this._status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.void: can only void an authorized payment (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.VOIDED;
  }

  // Marks that this payment owes a refund. Driven by Cancel Order when it cancels an
  // order whose payment was already **captured** — the money is gone, so cancellation
  // cannot simply void it; it flags the row and the refund capability issues the
  // actual refund. **Idempotent** — flagging an already-flagged payment is a no-op, not
  // an error. The flag is orthogonal to `status` (a captured payment stays `captured`
  // while flagged); only a refund moves the status (`refund()` below, ADR-028 §6).
  public flagForRefund(): void {
    this._flaggedForRefund = true;
  }

  // Records a refund of `amountMinor` against this captured payment — the writer of the
  // `refunded_amount_minor` counter that shipped ahead of its consumer (ADR-028 §6).
  // Driven by the Issue Refund use case **after** the gateway confirms the refund; the
  // use case validates the request against the refundable ceiling first, so the guards
  // here are defense-in-depth (an internal caller bug, not a user-reachable rejection):
  //
  // - `amountMinor` must be a positive integer — a **plain `Error`** (a use case never
  //   reaches this with a bad amount; the typed `REFUND_AMOUNT_INVALID` lives on `Refund`).
  // - the payment must be `CAPTURED` — only captured money can be reversed. The use case
  //   surfaces `REFUND_PAYMENT_NOT_CAPTURED` first, but the domain also rejects it with
  //   `PAYMENT_INVALID_STATUS_TRANSITION` (409) so the invariant holds even off the
  //   happy path (the `capture`/`void` transition-guard precedent).
  // - the running total must not exceed the captured amount
  //   (`refundedAmountMinor + amountMinor ≤ amountMinor`) — a **plain `Error**` (the use
  //   case surfaces the typed `REFUND_EXCEEDS_REFUNDABLE` first).
  //
  // Effect: accumulate `refundedAmountMinor`; on a **full** refund (the cumulative total
  // now equals the captured amount) walk `status → REFUNDED` and clear
  // `flaggedForRefund` (a full refund settles the flag Cancel Order set). A **partial**
  // refund leaves `status = CAPTURED` and the flag untouched — a captured order may still
  // owe more, and a later refund completes it.
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
