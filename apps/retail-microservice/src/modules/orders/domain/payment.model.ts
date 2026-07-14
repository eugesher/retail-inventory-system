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
  // Set by Cancel Order when it cancels an order whose payment was already captured. Optional on
  // the load path and defaults `false` — a freshly authorized payment is never flagged.
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
// events — the use cases own the wire events, never the payment domain.
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

  // **`flaggedForRefund` is orthogonal to `status`.** A captured payment that Cancel Order flagged
  // stays `CAPTURED` — the flag says money is *owed back*, not that it has moved. Only `refund()`
  // moves the status.
  public get flaggedForRefund(): boolean {
    return this._flaggedForRefund;
  }

  // The **cumulative** total refunded against this payment, not the last refund's amount. A partial
  // refund leaves the payment `CAPTURED` and this number short of `amountMinor`; the difference is
  // what may still be refunded.
  public get refundedAmountMinor(): number {
    return this._refundedAmountMinor;
  }

  // `AUTHORIZED → CAPTURING` — **the durable claim, and the transition that must commit BEFORE the
  // gateway is called** (ADR-052). It is not bookkeeping: it is the mutual exclusion. Both capture
  // paths (explicit capture, ship-triggered capture) take it under a `SELECT … FOR UPDATE`, so the
  // loser of a race blocks on the row, wakes to find `CAPTURING` rather than `AUTHORIZED`, and is
  // rejected **before it can reach the processor**.
  //
  // The rejection is `PAYMENT_INVALID_STATUS_TRANSITION` (409) — the same code a double-capture
  // raised before, but now raised at the only moment it is worth anything: while the money is still
  // in the customer's account.
  public beginCapture(): void {
    if (this._status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.beginCapture: can only claim an authorized payment (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.CAPTURING;
  }

  // `CAPTURING → CAPTURED`, stamping `capturedAt`. **Records that money moved; it does not move it.**
  // The gateway has already confirmed by the time this runs, and the claim proves this caller was the
  // one entitled to ask.
  //
  // It refuses to complete a capture nobody claimed. That is not defensive noise: a path that reaches
  // `CAPTURED` without passing through `CAPTURING` is a path that charged the gateway without holding
  // the lock, which is the entire defect ADR-052 exists to make unexpressible.
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

  // `CAPTURING → AUTHORIZED` — the claim released because the gateway **declined**, so no money
  // moved and the authorization is still capturable.
  //
  // **Only a caller that KNOWS the charge did not land may call this.** A caller that merely *thinks*
  // so — a crashed request, a timeout, a sweeper guessing — must not: releasing a claim whose charge
  // actually landed hands the next caller a second charge on the same authorization. That is why the
  // stale-claim sweeper only *surfaces* `CAPTURING` rows and never resolves them (ADR-052), and why
  // this method is reachable from exactly one place: the explicit `!result.captured` branch.
  public releaseCapture(): void {
    if (this._status !== PaymentStatusEnum.CAPTURING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.releaseCapture: can only release a claimed capture (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.AUTHORIZED;
  }

  // `AUTHORIZED → VOIDED`. Driven by Cancel Order when it cancels an order whose
  // payment was authorized but never captured: no money was taken, so none needs giving back. A
  // captured payment cannot come here — it goes to `flagForRefund` instead.
  //
  // **This void is bookkeeping only.** The bound gateway is a fake that never reserved real funds,
  // so nothing is released anywhere; a real processor would need its authorization voided here, and
  // that call does not exist. The row will say `VOIDED` regardless.
  public void(): void {
    if (this._status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment.void: can only void an authorized payment (current: ${this._status})`,
      );
    }
    this._status = PaymentStatusEnum.VOIDED;
  }

  // **Cancel Order's answer when the money has already moved.** A captured payment cannot be voided
  // — the funds are gone — so cancellation flags the row and leaves the actual reversal to a refund.
  // **Flagging is idempotent**, and it is a *claim*, not a settlement: the flag alone gives nobody
  // their money back.
  public flagForRefund(): void {
    this._flaggedForRefund = true;
  }

  // Records a refund against this captured payment. **Driven by Issue Refund AFTER the gateway has
  // confirmed** — this method never asks anyone for money, it only writes down that money went
  // back. Calling it without a confirmed gateway refund records a lie.
  //
  // The use case validates against the refundable ceiling first, so the guards below are
  // defence-in-depth against an internal bug, not user-reachable rejections:
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
