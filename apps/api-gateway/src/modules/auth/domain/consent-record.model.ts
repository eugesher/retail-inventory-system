import type { ConsentRecordView } from '@retail-inventory-system/contracts';

export const DEFAULT_DATA_RETENTION_POLICY = 'default-7-years';

export interface IConsentRecordProps {
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
  updatedAt: Date | null;
}

export interface IConsentApply {
  transactionalEmail?: boolean;
  marketingEmail?: boolean;
  marketingSms?: boolean;
  dataRetentionPolicy?: string;
}

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

  public static default(customerId: string): ConsentRecord {
    return new ConsentRecord(customerId, {
      transactionalEmail: true,
      marketingEmail: false,
      marketingSms: false,
      dataRetentionPolicy: DEFAULT_DATA_RETENTION_POLICY,
      updatedAt: null,
    });
  }

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
