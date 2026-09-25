import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { NotificationDomainException } from './notification.exception';
import { NotificationErrorCodeEnum } from './notification-error-code.enum';

export interface INotificationDeliveryProps {
  id: number | null;
  templateId: number;
  recipientCustomerId: string | null;
  recipientAddress: string;
  channel: NotificationChannelEnum;
  eventReferenceType: string;
  eventReferenceId: string;
  status: NotificationDeliveryStatusEnum;
  attemptCount: number;
  lastAttemptAt: Date | null;
  failureReason: string | null;
  renderedSubject: string | null;
  renderedBody: string;
  correlationId: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

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

  public static open(input: IOpenNotificationDeliveryInput): NotificationDelivery {
    return NotificationDelivery.create(input, NotificationDeliveryStatusEnum.QUEUED);
  }

  public static skipped(input: IOpenNotificationDeliveryInput): NotificationDelivery {
    return NotificationDelivery.create(input, NotificationDeliveryStatusEnum.SKIPPED_NO_CONSENT);
  }

  private static create(
    input: IOpenNotificationDeliveryInput,
    status: NotificationDeliveryStatusEnum,
  ): NotificationDelivery {
    NotificationDelivery.assertCreatable(input);

    return new NotificationDelivery({
      id: null,
      templateId: input.templateId,
      recipientCustomerId: input.recipientCustomerId,
      recipientAddress: input.recipientAddress,
      channel: input.channel,
      eventReferenceType: input.eventReferenceType,
      eventReferenceId: input.eventReferenceId,
      status,
      attemptCount: 0,
      lastAttemptAt: null,
      failureReason: null,
      renderedSubject: input.renderedSubject,
      renderedBody: input.renderedBody,
      correlationId: input.correlationId,
    });
  }

  private static assertCreatable(input: IOpenNotificationDeliveryInput): void {
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
  }

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

  public markSent(at: Date): void {
    this.assertAttemptable('markSent');
    this._status = NotificationDeliveryStatusEnum.SENT;
    this._attemptCount += 1;
    this._lastAttemptAt = at;
    this._failureReason = null;
  }

  public markFailed(at: Date, reason: string): void {
    this.assertAttemptable('markFailed');
    this._status = NotificationDeliveryStatusEnum.FAILED;
    this._attemptCount += 1;
    this._lastAttemptAt = at;
    this._failureReason = reason;
  }

  public markDelivered(): void {
    this.assertStatus(NotificationDeliveryStatusEnum.SENT, 'markDelivered');
    this._status = NotificationDeliveryStatusEnum.DELIVERED;
  }

  public markBounced(reason: string): void {
    this.assertStatus(NotificationDeliveryStatusEnum.SENT, 'markBounced');
    this._status = NotificationDeliveryStatusEnum.BOUNCED;
    this._failureReason = reason;
  }

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

  private assertStatus(expected: NotificationDeliveryStatusEnum, op: string): void {
    if (this._status !== expected) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
        `NotificationDelivery.${op}: can only ${op} a ${expected} delivery (current: ${this._status})`,
      );
    }
  }
}
