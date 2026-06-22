import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { NotificationDomainException } from './notification-domain.exception';
import { NotificationErrorCodeEnum } from './notification-error-code.enum';

export interface INotificationDeliveryProps {
  id: number | null;
  templateId: number;
  // Null for system/ops notifications (e.g. a low-stock alert to the ops mailbox); the
  // gateway customer UUID for customer-facing ones. A null recipient is NOT deduped (see
  // ADR-033) — the dedupe generated column is null when this is null.
  recipientCustomerId: string | null;
  recipientAddress: string;
  channel: NotificationChannelEnum;
  // The business event that triggered this delivery —
  // `order`/`return-request`/`stock-low`/`fulfillment`/`refund` + its id.
  eventReferenceType: string;
  eventReferenceId: string;
  status: NotificationDeliveryStatusEnum;
  // Monotonic — climbs on each send/fail attempt, never decreases.
  attemptCount: number;
  lastAttemptAt: Date | null;
  failureReason: string | null;
  renderedSubject: string | null;
  renderedBody: string;
  correlationId: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the `open` factory — everything known the moment a notification is about to
// be dispatched. The renderer has already produced `renderedSubject` / `renderedBody`
// from the resolved template; the dispatch use case persists the delivery row in
// `queued` BEFORE the NOTIFIER call so a crash mid-send still leaves an auditable row
// (ADR-033). `status` / `attemptCount` / `lastAttemptAt` are set by the factory, never
// supplied.
export interface IOpenNotificationDeliveryInput {
  templateId: number;
  recipientCustomerId: string | null;
  recipientAddress: string;
  channel: NotificationChannelEnum;
  eventReferenceType: string;
  eventReferenceId: string;
  renderedSubject: string | null;
  renderedBody: string;
  correlationId: string;
}

// `NotificationDelivery` is the queryable audit trail of one outgoing notification — the
// source of truth for "did we already send this, and how did it go?" (ADR-033). Its
// `status` walks `QUEUED → SENT → DELIVERED | BOUNCED`, with `QUEUED|FAILED → FAILED`
// (and `FAILED → SENT` once a retry succeeds) — the retry sweeper re-attempts `failed`
// rows. The row is **live-ephemeral**: it is never deleted (a `RETENTION_DELIVERY_DAYS`
// purge is a deferred future capability), so `deletedAt` stays inert.
//
// `attemptCount` is **monotonic** — only `markSent` / `markFailed` (the two
// attempt-consuming transitions) increment it; `markDelivered` / `markBounced` record a
// downstream receipt and leave it. It therefore never decreases, which is what lets the
// retry sweeper cap re-attempts at `MAX_DELIVERY_ATTEMPTS`.
//
// Records **no** domain events here — the Render & Dispatch use case (a later
// capability) emits the `notifications.delivery.*` wire events after it persists the
// row (the `Order.place` / ADR-011 precedent).
export class NotificationDelivery extends AggregateRoot<number | null> {
  private readonly _templateId: number;
  private readonly _recipientCustomerId: string | null;
  private readonly _recipientAddress: string;
  private readonly _channel: NotificationChannelEnum;
  private readonly _eventReferenceType: string;
  private readonly _eventReferenceId: string;
  private _status: NotificationDeliveryStatusEnum;
  private _attemptCount: number;
  private _lastAttemptAt: Date | null;
  private _failureReason: string | null;
  private readonly _renderedSubject: string | null;
  private readonly _renderedBody: string;
  private readonly _correlationId: string;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: INotificationDeliveryProps) {
    super(props.id);
    this._templateId = props.templateId;
    this._recipientCustomerId = props.recipientCustomerId;
    this._recipientAddress = props.recipientAddress;
    this._channel = props.channel;
    this._eventReferenceType = props.eventReferenceType;
    this._eventReferenceId = props.eventReferenceId;
    this._status = props.status;
    this._attemptCount = props.attemptCount;
    this._lastAttemptAt = props.lastAttemptAt;
    this._failureReason = props.failureReason;
    this._renderedSubject = props.renderedSubject;
    this._renderedBody = props.renderedBody;
    this._correlationId = props.correlationId;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // Opens a delivery in `QUEUED` with `attemptCount = 0` / `lastAttemptAt = null`. The
  // recipient address is the one externally-meaningful invariant (a customer with no
  // email reaches here) → a typed `DELIVERY_RECIPIENT_REQUIRED`. `renderedBody` /
  // `correlationId` / `templateId` are plumbing the dispatch use case always supplies —
  // an empty one is an internal-caller bug, so it throws a plain `Error` (the
  // `Reservation.create` non-future-expiry precedent), never a wire-mappable code.
  public static open(input: IOpenNotificationDeliveryInput): NotificationDelivery {
    if (!input.recipientAddress || input.recipientAddress.trim().length === 0) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_RECIPIENT_REQUIRED,
        'NotificationDelivery.recipientAddress must be non-empty',
      );
    }
    if (!Number.isInteger(input.templateId) || input.templateId <= 0) {
      throw new Error(
        `NotificationDelivery.templateId must be a positive integer, got ${input.templateId}`,
      );
    }
    if (!input.renderedBody || input.renderedBody.trim().length === 0) {
      throw new Error('NotificationDelivery.renderedBody must be non-empty');
    }
    if (!input.correlationId || input.correlationId.trim().length === 0) {
      throw new Error('NotificationDelivery.correlationId must be non-empty');
    }

    return new NotificationDelivery({
      id: null,
      templateId: input.templateId,
      recipientCustomerId: input.recipientCustomerId,
      recipientAddress: input.recipientAddress,
      channel: input.channel,
      eventReferenceType: input.eventReferenceType,
      eventReferenceId: input.eventReferenceId,
      status: NotificationDeliveryStatusEnum.QUEUED,
      attemptCount: 0,
      lastAttemptAt: null,
      failureReason: null,
      renderedSubject: input.renderedSubject,
      renderedBody: input.renderedBody,
      correlationId: input.correlationId,
    });
  }

  // Rebuilds a persisted delivery from storage (any status). Records no events.
  public static reconstitute(props: INotificationDeliveryProps): NotificationDelivery {
    return new NotificationDelivery(props);
  }

  public get templateId(): number {
    return this._templateId;
  }

  public get recipientCustomerId(): string | null {
    return this._recipientCustomerId;
  }

  public get recipientAddress(): string {
    return this._recipientAddress;
  }

  public get channel(): NotificationChannelEnum {
    return this._channel;
  }

  public get eventReferenceType(): string {
    return this._eventReferenceType;
  }

  public get eventReferenceId(): string {
    return this._eventReferenceId;
  }

  public get status(): NotificationDeliveryStatusEnum {
    return this._status;
  }

  public get attemptCount(): number {
    return this._attemptCount;
  }

  public get lastAttemptAt(): Date | null {
    return this._lastAttemptAt;
  }

  public get failureReason(): string | null {
    return this._failureReason;
  }

  public get renderedSubject(): string | null {
    return this._renderedSubject;
  }

  public get renderedBody(): string {
    return this._renderedBody;
  }

  public get correlationId(): string {
    return this._correlationId;
  }

  // `QUEUED|FAILED → SENT` — the NOTIFIER accepted the message. Counts as an attempt:
  // increments `attemptCount`, stamps `lastAttemptAt`, and clears any prior
  // `failureReason` (this attempt succeeded).
  public markSent(at: Date): void {
    this.assertAttemptable('markSent');
    this._status = NotificationDeliveryStatusEnum.SENT;
    this._attemptCount += 1;
    this._lastAttemptAt = at;
    this._failureReason = null;
  }

  // `QUEUED|FAILED → FAILED` — the NOTIFIER rejected the message. Counts as an attempt:
  // increments `attemptCount`, stamps `lastAttemptAt`, and records the reason for the
  // retry sweeper + the audit trail.
  public markFailed(at: Date, reason: string): void {
    this.assertAttemptable('markFailed');
    this._status = NotificationDeliveryStatusEnum.FAILED;
    this._attemptCount += 1;
    this._lastAttemptAt = at;
    this._failureReason = reason;
  }

  // `SENT → DELIVERED` — a downstream delivery receipt confirmed it landed. Terminal,
  // records no attempt (the wire transport already accepted it).
  public markDelivered(): void {
    this.assertStatus(NotificationDeliveryStatusEnum.SENT, 'markDelivered');
    this._status = NotificationDeliveryStatusEnum.DELIVERED;
  }

  // `SENT → BOUNCED` — a downstream bounce notice. Terminal, records the bounce reason,
  // no attempt.
  public markBounced(reason: string): void {
    this.assertStatus(NotificationDeliveryStatusEnum.SENT, 'markBounced');
    this._status = NotificationDeliveryStatusEnum.BOUNCED;
    this._failureReason = reason;
  }

  // The two attempt-consuming transitions (`markSent` / `markFailed`) are legal only
  // from a non-terminal, attemptable state: `QUEUED` (first try) or `FAILED` (retry).
  // From `SENT` / `DELIVERED` / `BOUNCED` they are illegal.
  private assertAttemptable(op: string): void {
    const attemptable =
      this._status === NotificationDeliveryStatusEnum.QUEUED ||
      this._status === NotificationDeliveryStatusEnum.FAILED;
    if (!attemptable) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
        `NotificationDelivery.${op}: can only ${op} a queued or failed delivery (current: ${this._status})`,
      );
    }
  }

  // Shared single-source transition guard for the receipt transitions
  // (`markDelivered` / `markBounced`), which require an exact prior `SENT`.
  private assertStatus(expected: NotificationDeliveryStatusEnum, op: string): void {
    if (this._status !== expected) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
        `NotificationDelivery.${op}: can only ${op} a ${expected} delivery (current: ${this._status})`,
      );
    }
  }
}
