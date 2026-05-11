import { AggregateRoot } from '@retail-inventory-system/ddd';

import { RoleVO } from './role.model';
import { UserLoggedInEvent } from './events/user-logged-in.event';
import { UserRegisteredEvent } from './events/user-registered.event';

export interface IPasswordHasher {
  verify(hash: string, candidate: string): Promise<boolean>;
}

interface IUserProps {
  email: string;
  passwordHash: string;
  roles: RoleVO[];
  refreshTokenHash?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class User extends AggregateRoot<string> {
  private _email: string;
  private _passwordHash: string;
  private _roles: RoleVO[];
  private _refreshTokenHash: string | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;
  public readonly deletedAt: Date | null;

  private constructor(id: string, props: IUserProps) {
    super(id);

    if (!props.email || !EMAIL_REGEX.test(props.email)) {
      throw new Error('User: email must be a valid email address');
    }
    if (!props.passwordHash) {
      throw new Error('User: passwordHash must be non-empty');
    }
    if (!props.roles || props.roles.length === 0) {
      throw new Error('User: roles must be non-empty');
    }

    this._email = props.email.toLowerCase();
    this._passwordHash = props.passwordHash;
    this._roles = [...props.roles];
    this._refreshTokenHash = props.refreshTokenHash ?? null;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
    this.deletedAt = props.deletedAt ?? null;
  }

  public static register(id: string, props: IUserProps): User {
    const user = new User(id, props);
    user.addDomainEvent(new UserRegisteredEvent(id, user._email));
    return user;
  }

  public static rehydrate(id: string, props: IUserProps): User {
    return new User(id, props);
  }

  public get email(): string {
    return this._email;
  }

  public get passwordHash(): string {
    return this._passwordHash;
  }

  public get roles(): readonly RoleVO[] {
    return this._roles;
  }

  public get refreshTokenHash(): string | null {
    return this._refreshTokenHash;
  }

  public get isActive(): boolean {
    return this.deletedAt === null;
  }

  public assignRole(role: RoleVO): void {
    if (this._roles.some((existing) => existing.equals(role))) {
      return;
    }
    this._roles.push(role);
  }

  public revokeRole(role: RoleVO): void {
    if (this._roles.length <= 1) {
      throw new Error('User: cannot revoke the last remaining role');
    }
    this._roles = this._roles.filter((existing) => !existing.equals(role));
  }

  public rotateRefreshTokenHash(hash: string | null): void {
    this._refreshTokenHash = hash;
  }

  public async validatePassword(candidate: string, hasher: IPasswordHasher): Promise<boolean> {
    return hasher.verify(this._passwordHash, candidate);
  }

  public recordLoggedIn(): void {
    this.addDomainEvent(new UserLoggedInEvent(this.id, this._email));
  }
}
