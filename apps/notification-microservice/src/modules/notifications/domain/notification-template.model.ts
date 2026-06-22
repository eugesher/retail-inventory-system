import { NotificationChannelEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { NotificationDomainException } from './notification-domain.exception';
import { NotificationErrorCodeEnum } from './notification-error-code.enum';

export interface INotificationTemplateProps {
  id: number | null;
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  // Null for sms/push (no subject line); non-null for email/webhook.
  subject: string | null;
  body: string;
  // The BUSINESS version — an INT that climbs on every edit. NOT an OCC token (see the
  // class doc); an edit appends a brand-new row at `version + 1` rather than rewriting.
  version: number;
  active: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the `create` factory — the authored content for one template version.
// `version` is supplied by the caller (the Author use case derives it from the
// registry's current `maxVersion + 1`); the factory always opens the new row `active`.
export interface ICreateNotificationTemplateInput {
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject: string | null;
  body: string;
  version: number;
}

// Input to `withNextVersion` — the edited content. `eventType` / `channel` / `locale`
// are fixed (they are the registry key); only `subject` / `body` change, and the
// version is derived (`this.version + 1`).
export interface IEditNotificationTemplateInput {
  subject: string | null;
  body: string;
}

// `NotificationTemplate` is one versioned entry in the per
// `(eventType, channel, locale)` registry that backs every rendered notification
// (ADR-033). An **edit appends a new `version`** rather than rewriting the row, so the
// full edit history is retained for audit / rollback; the live entry is the
// highest-`version` `active` row for the key. It is soft-deleted via the `active` flag
// (never a `deletedAt` timestamp — the `StockLocation` / `Category` convention), so a
// deactivated template stays on the row and out of the "find latest active" resolution.
//
// **`version` is the BUSINESS version, not an OCC `@VersionColumn`.** It is a plain INT
// the registry owns: it identifies *which* edit this row is, is part of the natural key
// `(eventType, channel, locale, version)`, and climbs by one per edit. This is distinct
// from `order.version` / `fulfillment.version`, which are TypeORM-managed
// optimistic-lock tokens that advance on every persist regardless of business meaning.
// The notification tables ship **no** OCC column — last-writer-wins is acceptable for a
// staff-authored registry (the catalog last-writer-wins stance, ADR-025).
//
// Records **no** domain events (the `Category` / `MediaAsset` precedent, ADR-029) — a
// template edit is an internal registry change, not a cross-service fact.
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

  // The authoring factory: validates the shape invariants (non-empty
  // eventType/locale/body, positive-integer version, the channel-specific subject
  // rule) and opens the new version `active`. `id` is null until persistence assigns
  // the BIGINT. Records no domain event.
  public static create(input: ICreateNotificationTemplateInput): NotificationTemplate {
    NotificationTemplate.assertContent(input.eventType, input.locale, input.body);
    NotificationTemplate.assertSubjectForChannel(input.channel, input.subject);
    NotificationTemplate.assertVersion(input.version);

    return new NotificationTemplate({
      id: null,
      eventType: input.eventType,
      channel: input.channel,
      locale: input.locale,
      // Normalize an empty/whitespace subject to null for the optional (sms/push)
      // channels, so the persisted nullable column is honest.
      subject: input.subject && input.subject.trim().length > 0 ? input.subject : null,
      body: input.body,
      version: input.version,
      active: true,
    });
  }

  // Rebuilds a persisted template from storage (any version / active state). No
  // re-validation — the row was valid when written. Records no events.
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

  // Soft-delete: flip the registry entry out of "find latest active". Idempotent — a
  // second call on an already-inactive template is a no-op (no throw), the
  // `MediaAsset`-style state flip without a transition guard since `active` carries no
  // illegal-transition meaning here.
  public deactivate(): void {
    this._active = false;
  }

  // The inverse of `deactivate` — re-include the entry in the live resolution.
  // Idempotent.
  public activate(): void {
    this._active = true;
  }

  // Derives the **next version** of this template from an edit — the Author use case's
  // "edit bumps version" operation. It returns a BRAND-NEW `NotificationTemplate` for
  // the same `(eventType, channel, locale)` at `version + 1`, `active`, `id` null (a
  // fresh row to be inserted): the current row is left untouched so the edit history is
  // retained (ADR-033). It re-runs the shape invariants (a next version of an email
  // template still needs a subject), so an edit that drops a required subject is
  // rejected just like an initial create.
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

  // The channel-specific subject rule: `email`/`webhook` carry a subject line (an email
  // without one is malformed); `sms`/`push` do not. The set of subject-bearing channels
  // is the single source of truth here.
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
