import { NotificationChannelEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { NotificationDomainException } from './notification.exception';
import { NotificationErrorCodeEnum } from './notification-error-code.enum';

export interface INotificationTemplateProps {
  id: number | null;
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject: string | null;
  body: string;
  version: number;
  active: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface ICreateNotificationTemplateInput {
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject: string | null;
  body: string;
  version: number;
}

export interface IEditNotificationTemplateInput {
  subject: string | null;
  body: string;
}

export class NotificationTemplate extends AggregateRoot<number | null> {
  private readonly _eventType: string;
  private readonly _channel: NotificationChannelEnum;
  private readonly _locale: string;
  private readonly _subject: string | null;
  private readonly _body: string;
  private readonly _version: number;
  private _active: boolean;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: INotificationTemplateProps) {
    super(props.id);
    this._eventType = props.eventType;
    this._channel = props.channel;
    this._locale = props.locale;
    this._subject = props.subject;
    this._body = props.body;
    this._version = props.version;
    this._active = props.active;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static create(input: ICreateNotificationTemplateInput): NotificationTemplate {
    NotificationTemplate.assertContent(input.eventType, input.locale, input.body);
    NotificationTemplate.assertSubjectForChannel(input.channel, input.subject);
    NotificationTemplate.assertVersion(input.version);

    return new NotificationTemplate({
      id: null,
      eventType: input.eventType,
      channel: input.channel,
      locale: input.locale,
      subject: input.subject && input.subject.trim().length > 0 ? input.subject : null,
      body: input.body,
      version: input.version,
      active: true,
    });
  }

  public static reconstitute(props: INotificationTemplateProps): NotificationTemplate {
    return new NotificationTemplate(props);
  }

  public get eventType(): string {
    return this._eventType;
  }

  public get channel(): NotificationChannelEnum {
    return this._channel;
  }

  public get locale(): string {
    return this._locale;
  }

  public get subject(): string | null {
    return this._subject;
  }

  public get body(): string {
    return this._body;
  }

  public get version(): number {
    return this._version;
  }

  public get active(): boolean {
    return this._active;
  }

  public deactivate(): void {
    this._active = false;
  }

  public activate(): void {
    this._active = true;
  }

  public withNextVersion(input: IEditNotificationTemplateInput): NotificationTemplate {
    return NotificationTemplate.create({
      eventType: this._eventType,
      channel: this._channel,
      locale: this._locale,
      subject: input.subject,
      body: input.body,
      version: this._version + 1,
    });
  }

  private static assertContent(eventType: string, locale: string, body: string): void {
    if (!eventType || eventType.trim().length === 0) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_EVENT_TYPE_REQUIRED,
        'NotificationTemplate.eventType must be non-empty',
      );
    }
    if (!locale || locale.trim().length === 0) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_LOCALE_REQUIRED,
        'NotificationTemplate.locale must be non-empty',
      );
    }
    if (!body || body.trim().length === 0) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_BODY_REQUIRED,
        'NotificationTemplate.body must be non-empty',
      );
    }
  }

  private static assertSubjectForChannel(
    channel: NotificationChannelEnum,
    subject: string | null,
  ): void {
    const requiresSubject =
      channel === NotificationChannelEnum.EMAIL || channel === NotificationChannelEnum.WEBHOOK;
    if (requiresSubject && (!subject || subject.trim().length === 0)) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_SUBJECT_REQUIRED,
        `NotificationTemplate.subject is required for the ${channel} channel`,
      );
    }
  }

  private static assertVersion(version: number): void {
    if (!Number.isInteger(version) || version <= 0) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_VERSION_INVALID,
        `NotificationTemplate.version must be a positive integer, got ${version}`,
      );
    }
  }
}
