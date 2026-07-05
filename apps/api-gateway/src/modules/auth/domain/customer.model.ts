import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CustomerLoggedInEvent, CustomerRegisteredEvent } from './events';
import { IPasswordHasher } from './staff-user.model';

type CustomerStatus = 'active' | 'suspended' | 'guest' | 'deleted';

const ALLOWED_STATUSES: ReadonlySet<CustomerStatus> = new Set([
  'active',
  'suspended',
  'guest',
  'deleted',
]);

interface ICustomerProps {
  // `email` is nullable so the model can *represent* a tombstone: an erased
  // (`status='deleted'`) customer has its PII nulled while its id survives
  // (ADR-028 §1, the nullable-FK-leaves-an-order-tombstone reasoning). The
  // constructor invariant below is status-conditional accordingly.
  email: string | null;
  passwordHash: string | null;
  status?: CustomerStatus;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  emailVerifiedAt?: Date | null;
  refreshTokenHash?: string | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Customer extends AggregateRoot<string> {
  private _status: CustomerStatus;
  private _emailVerifiedAt: Date | null;
  private _refreshTokenHash: string | null;
  private _deletedAt: Date | null;
  // The PII fields are mutable (not `readonly`) solely so `erase()` can null them
  // in place. Nothing else reassigns them — a live customer's PII is set once in
  // the constructor and only the tombstone-erase clears it (ADR-037 §2).
  private _email: string | null;
  private _passwordHash: string | null;
  private _phone: string | null;
  private _firstName: string | null;
  private _lastName: string | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(id: string, props: ICustomerProps) {
    super(id);

    const status: CustomerStatus = props.status ?? 'active';
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`Customer: unknown status "${status}"`);
    }

    // Status-conditional email invariant: a live customer (any status other than
    // `deleted`) MUST carry a syntactically valid email; a tombstoned
    // (`status='deleted'`) customer may have a null email — its PII was nulled by
    // the erase, and the model must be able to rehydrate that row without throwing.
    if (status !== 'deleted' && (!props.email || !EMAIL_REGEX.test(props.email))) {
      throw new Error('Customer: email must be a valid email address');
    }

    const passwordHash = props.passwordHash ?? null;
    if (passwordHash === null && status !== 'guest' && status !== 'deleted') {
      throw new Error(
        'Customer: passwordHash may be null only for status="guest" or status="deleted"',
      );
    }

    this._email = props.email ? props.email.toLowerCase() : null;
    this._passwordHash = passwordHash;
    this._status = status;
    this._phone = props.phone ?? null;
    this._firstName = props.firstName ?? null;
    this._lastName = props.lastName ?? null;
    this._emailVerifiedAt = props.emailVerifiedAt ?? null;
    this._refreshTokenHash = props.refreshTokenHash ?? null;
    this._deletedAt = props.deletedAt ?? null;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static register(id: string, props: ICustomerProps): Customer {
    const customer = new Customer(id, props);
    // `register` is the live-customer create path; the constructor guarantees a
    // non-null email for any non-`deleted` status, so `_email` is a real string
    // here (the `authorizedAt!` post-transition idiom).
    customer.addDomainEvent(new CustomerRegisteredEvent(id, customer._email!));
    return customer;
  }

  public static rehydrate(id: string, props: ICustomerProps): Customer {
    return new Customer(id, props);
  }

  // Null only for a tombstoned (`status='deleted'`) customer whose PII was
  // nulled on erase; a live customer always has an email.
  public get email(): string | null {
    return this._email;
  }

  public get passwordHash(): string | null {
    return this._passwordHash;
  }

  public get status(): CustomerStatus {
    return this._status;
  }

  public get phone(): string | null {
    return this._phone;
  }

  public get firstName(): string | null {
    return this._firstName;
  }

  public get lastName(): string | null {
    return this._lastName;
  }

  public get emailVerifiedAt(): Date | null {
    return this._emailVerifiedAt;
  }

  public get refreshTokenHash(): string | null {
    return this._refreshTokenHash;
  }

  // The tombstone marker: null for a live customer, set to the erase instant for
  // a `status='deleted'` row. Loaded on rehydrate and set by `erase()`.
  public get deletedAt(): Date | null {
    return this._deletedAt;
  }

  public get isActive(): boolean {
    return this._status === 'active';
  }

  public suspend(): void {
    this._status = 'suspended';
  }

  public reactivate(): void {
    this._status = 'active';
  }

  public markEmailVerified(at: Date = new Date()): void {
    this._emailVerifiedAt = at;
  }

  public rotateRefreshTokenHash(hash: string | null): void {
    this._refreshTokenHash = hash;
  }

  // Tombstone-erase this customer (ADR-037 §2). Nulls every PII field, flips the
  // status to `deleted`, stamps `deletedAt` with the erase instant, and clears the
  // refresh-token hash — a **session revocation**: a live refresh token can no
  // longer roll forward, and `existsAuthenticatableById` (`status IN
  // ('active','guest')`) already bars a `deleted` row from authenticating. The id
  // is deliberately preserved so every `order.customer_id` FK stays valid and the
  // sales history survives — the whole reason the FK was made nullable (ADR-028
  // §1). Records **no** domain event: the erase use case emits the `customer.erased`
  // wire event, keeping this aggregate event-light (the ConsentRecord/Category
  // precedent). Idempotent — re-erasing an already-`deleted` customer re-nulls the
  // same (already-null) fields and re-stamps `deletedAt`, a no-op in effect.
  public erase(at: Date = new Date()): void {
    this._status = 'deleted';
    this._deletedAt = at;
    this._email = null;
    this._phone = null;
    this._firstName = null;
    this._lastName = null;
    this._passwordHash = null;
    this._emailVerifiedAt = null;
    this._refreshTokenHash = null;
  }

  public async validatePassword(candidate: string, hasher: IPasswordHasher): Promise<boolean> {
    if (this._passwordHash === null) {
      return false;
    }
    return hasher.verify(this._passwordHash, candidate);
  }

  public recordLoggedIn(): void {
    // Only an authenticatable (active/guest) customer reaches a login, and those
    // always carry a non-null email; a tombstoned customer cannot authenticate.
    this.addDomainEvent(new CustomerLoggedInEvent(this.id, this._email!));
  }

  // `passwordHash` and `refreshTokenHash` must never leak through structured
  // logging or response serialization.
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      email: this._email,
      status: this._status,
      phone: this._phone,
      firstName: this._firstName,
      lastName: this._lastName,
      emailVerifiedAt: this._emailVerifiedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
