import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CustomerLoggedInEvent } from './events/customer-logged-in.event';
import { CustomerRegisteredEvent } from './events/customer-registered.event';
import { IPasswordHasher } from './staff-user.model';

export type CustomerStatus = 'active' | 'suspended' | 'guest' | 'deleted';

const ALLOWED_STATUSES: ReadonlySet<CustomerStatus> = new Set([
  'active',
  'suspended',
  'guest',
  'deleted',
]);

interface ICustomerProps {
  email: string;
  passwordHash: string | null;
  status?: CustomerStatus;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  emailVerifiedAt?: Date | null;
  refreshTokenHash?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Customer extends AggregateRoot<string> {
  private _email: string;
  private _passwordHash: string | null;
  private _status: CustomerStatus;
  private _phone: string | null;
  private _firstName: string | null;
  private _lastName: string | null;
  private _emailVerifiedAt: Date | null;
  private _refreshTokenHash: string | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(id: string, props: ICustomerProps) {
    super(id);

    if (!props.email || !EMAIL_REGEX.test(props.email)) {
      throw new Error('Customer: email must be a valid email address');
    }
    const status: CustomerStatus = props.status ?? 'active';
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(`Customer: unknown status "${status}"`);
    }

    const passwordHash = props.passwordHash ?? null;
    if (passwordHash === null && status !== 'guest' && status !== 'deleted') {
      throw new Error(
        'Customer: passwordHash may be null only for status="guest" or status="deleted"',
      );
    }

    this._email = props.email.toLowerCase();
    this._passwordHash = passwordHash;
    this._status = status;
    this._phone = props.phone ?? null;
    this._firstName = props.firstName ?? null;
    this._lastName = props.lastName ?? null;
    this._emailVerifiedAt = props.emailVerifiedAt ?? null;
    this._refreshTokenHash = props.refreshTokenHash ?? null;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static register(id: string, props: ICustomerProps): Customer {
    const customer = new Customer(id, props);
    customer.addDomainEvent(new CustomerRegisteredEvent(id, customer._email));
    return customer;
  }

  public static rehydrate(id: string, props: ICustomerProps): Customer {
    return new Customer(id, props);
  }

  public get email(): string {
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

  public async validatePassword(candidate: string, hasher: IPasswordHasher): Promise<boolean> {
    if (this._passwordHash === null) {
      return false;
    }
    return hasher.verify(this._passwordHash, candidate);
  }

  public recordLoggedIn(): void {
    this.addDomainEvent(new CustomerLoggedInEvent(this.id, this._email));
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
