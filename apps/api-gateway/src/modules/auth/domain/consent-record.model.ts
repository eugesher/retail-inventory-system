import type { ConsentRecordView } from '@retail-inventory-system/contracts';

// The default data-retention policy label. A free-form string (not an enum) so
// operators can introduce new retention regimes without a schema change; the
// only well-known value today is the seven-year default that most retail/finance
// record-keeping rules land on.
export const DEFAULT_DATA_RETENTION_POLICY = 'default-7-years';

export interface IConsentRecordProps {
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
  updatedAt: Date | null;
}

// The subset a caller may overlay via `apply(...)`. Every key is optional —
// only the supplied keys are written (upsert-merge semantics); an omitted key
// keeps its current value. `updatedAt` is NOT settable here: it is the DB's
// `@UpdateDateColumn`, stamped by MySQL on write, loaded on rehydrate.
export interface IConsentApply {
  transactionalEmail?: boolean;
  marketingEmail?: boolean;
  marketingSms?: boolean;
  dataRetentionPolicy?: string;
}

// A customer's channel-consent record — 1:1 with `Customer`, keyed on the
// customer's CHAR(36) UUID. A framework-free plain class (the `StockLevel` /
// `Reservation` style, NOT an `AggregateRoot`): it records **no** domain events
// (the `Category` / `NotificationTemplate` precedent — the consent use cases
// emit `customer.consent.updated` themselves). Persistence is a no-`BaseEntity`
// row (only `updated_at`), so there is no surrogate id, `version`, or
// `created_at`/`deleted_at` — the customer id *is* the primary key.
//
// `transactionalEmail` defaults true (order confirmations are operationally
// required), the two marketing flags default false (opt-in — the GDPR posture).
// A customer with no stored row resolves to `ConsentRecord.default(customerId)`,
// so an absent row and an all-defaults row are indistinguishable downstream.
export class ConsentRecord {
  private readonly _customerId: string;
  private _transactionalEmail: boolean;
  private _marketingEmail: boolean;
  private _marketingSms: boolean;
  private _dataRetentionPolicy: string;
  private _updatedAt: Date | null;

  private constructor(customerId: string, props: IConsentRecordProps) {
    if (!customerId || customerId.trim().length === 0) {
      throw new Error('ConsentRecord: customerId is required');
    }

    this._customerId = customerId;
    this._transactionalEmail = props.transactionalEmail;
    this._marketingEmail = props.marketingEmail;
    this._marketingSms = props.marketingSms;
    this._dataRetentionPolicy = props.dataRetentionPolicy;
    this._updatedAt = props.updatedAt;
  }

  // What a customer with no stored row resolves to (the Read use case in the
  // consent capability, and the notification consent-gate). All defaults, no
  // `updatedAt` (nothing has been written).
  public static default(customerId: string): ConsentRecord {
    return new ConsentRecord(customerId, {
      transactionalEmail: true,
      marketingEmail: false,
      marketingSms: false,
      dataRetentionPolicy: DEFAULT_DATA_RETENTION_POLICY,
      updatedAt: null,
    });
  }

  // The load path — rehydrate a stored row into the model.
  public static rehydrate(customerId: string, props: IConsentRecordProps): ConsentRecord {
    return new ConsentRecord(customerId, props);
  }

  public get customerId(): string {
    return this._customerId;
  }

  public get transactionalEmail(): boolean {
    return this._transactionalEmail;
  }

  public get marketingEmail(): boolean {
    return this._marketingEmail;
  }

  public get marketingSms(): boolean {
    return this._marketingSms;
  }

  public get dataRetentionPolicy(): string {
    return this._dataRetentionPolicy;
  }

  public get updatedAt(): Date | null {
    return this._updatedAt;
  }

  // Overlay only the supplied keys — the upsert-merge the Record use case needs
  // (a customer PATCHing just `marketingEmail` leaves the other three untouched).
  // Returns `this` for a fluent `record.apply(partial)` at the call site.
  public apply(partial: IConsentApply): this {
    if (partial.transactionalEmail !== undefined) {
      this._transactionalEmail = partial.transactionalEmail;
    }
    if (partial.marketingEmail !== undefined) {
      this._marketingEmail = partial.marketingEmail;
    }
    if (partial.marketingSms !== undefined) {
      this._marketingSms = partial.marketingSms;
    }
    if (partial.dataRetentionPolicy !== undefined) {
      this._dataRetentionPolicy = partial.dataRetentionPolicy;
    }
    return this;
  }

  public toView(): ConsentRecordView {
    return {
      customerId: this._customerId,
      transactionalEmail: this._transactionalEmail,
      marketingEmail: this._marketingEmail,
      marketingSms: this._marketingSms,
      dataRetentionPolicy: this._dataRetentionPolicy,
      updatedAt: this._updatedAt ? this._updatedAt.toISOString() : null,
    };
  }
}
