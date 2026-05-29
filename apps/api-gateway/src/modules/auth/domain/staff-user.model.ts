import { PermissionCodeEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { StaffUserLoggedInEvent } from './events/staff-user-logged-in.event';
import { StaffUserRegisteredEvent } from './events/staff-user-registered.event';
import { StaffUserRoleRevokedEvent } from './events/staff-user-role-revoked.event';
import { StaffUserRolesAssignedEvent } from './events/staff-user-roles-assigned.event';
import { RoleAggregate } from './role.aggregate';

export interface IPasswordHasher {
  verify(hash: string, candidate: string): Promise<boolean>;
}

export type StaffUserStatus = 'active' | 'suspended';

interface IStaffUserProps {
  email: string;
  passwordHash: string;
  roles: RoleAggregate[];
  status?: StaffUserStatus;
  lastLoginAt?: Date | null;
  refreshTokenHash?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class StaffUser extends AggregateRoot<string> {
  private _email: string;
  private _passwordHash: string;
  private _roles: RoleAggregate[];
  private _status: StaffUserStatus;
  private _lastLoginAt: Date | null;
  private _refreshTokenHash: string | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;
  public readonly deletedAt: Date | null;

  private constructor(id: string, props: IStaffUserProps) {
    super(id);

    if (!props.email || !EMAIL_REGEX.test(props.email)) {
      throw new Error('StaffUser: email must be a valid email address');
    }
    if (!props.passwordHash) {
      throw new Error('StaffUser: passwordHash must be non-empty');
    }
    if (!props.roles || props.roles.length === 0) {
      throw new Error('StaffUser: roles must be non-empty');
    }

    this._email = props.email.toLowerCase();
    this._passwordHash = props.passwordHash;
    this._roles = [...props.roles];
    this._status = props.status ?? 'active';
    this._lastLoginAt = props.lastLoginAt ?? null;
    this._refreshTokenHash = props.refreshTokenHash ?? null;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
    this.deletedAt = props.deletedAt ?? null;
  }

  public static register(id: string, props: IStaffUserProps): StaffUser {
    const user = new StaffUser(id, props);
    user.addDomainEvent(new StaffUserRegisteredEvent(id, user._email));
    return user;
  }

  public static rehydrate(id: string, props: IStaffUserProps): StaffUser {
    return new StaffUser(id, props);
  }

  public get email(): string {
    return this._email;
  }

  public get passwordHash(): string {
    return this._passwordHash;
  }

  public get roles(): readonly RoleAggregate[] {
    return this._roles;
  }

  public get roleNames(): string[] {
    return this._roles.map((role) => role.name);
  }

  // The JWT permissions claim is the deduped, sorted union of every bound
  // role's permission set. Login and refresh must mint it identically, so the
  // computation lives on the aggregate rather than being copied to each caller.
  public get permissionCodes(): PermissionCodeEnum[] {
    return Array.from(new Set(this._roles.flatMap((role) => Array.from(role.permissions)))).sort();
  }

  public get status(): StaffUserStatus {
    return this._status;
  }

  public get lastLoginAt(): Date | null {
    return this._lastLoginAt;
  }

  public get refreshTokenHash(): string | null {
    return this._refreshTokenHash;
  }

  public get isActive(): boolean {
    return this._status === 'active' && this.deletedAt === null;
  }

  public assignRole(role: RoleAggregate): void {
    if (this._roles.some((existing) => existing.id === role.id)) {
      return;
    }
    this._roles.push(role);
  }

  public revokeRole(role: RoleAggregate): void {
    if (this._roles.length <= 1) {
      throw new Error('StaffUser: cannot revoke the last remaining role');
    }
    this._roles = this._roles.filter((existing) => existing.id !== role.id);
  }

  public suspend(): void {
    this._status = 'suspended';
  }

  public reactivate(): void {
    this._status = 'active';
  }

  public rotateRefreshTokenHash(hash: string | null): void {
    this._refreshTokenHash = hash;
  }

  public async validatePassword(candidate: string, hasher: IPasswordHasher): Promise<boolean> {
    return hasher.verify(this._passwordHash, candidate);
  }

  public recordLoggedIn(at: Date = new Date()): void {
    this._lastLoginAt = at;
    this.addDomainEvent(new StaffUserLoggedInEvent(this.id, this._email));
  }

  // The IAM use case computes the diff (the *added* names after dedupe) and
  // hands it in — keeping the diff calculation out of the aggregate avoids
  // baking IAM-specific logic into the domain. The aggregate just records.
  public recordRolesAssigned(addedRoleNames: readonly string[]): void {
    if (addedRoleNames.length === 0) return;
    this.addDomainEvent(new StaffUserRolesAssignedEvent(this.id, addedRoleNames));
  }

  public recordRoleRevoked(roleName: string): void {
    this.addDomainEvent(new StaffUserRoleRevokedEvent(this.id, roleName));
  }

  // `passwordHash` and `refreshTokenHash` must never leak through structured
  // logging or response serialization — `JSON.stringify` is the most common
  // accidental egress in NestJS request handlers.
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      email: this._email,
      status: this._status,
      lastLoginAt: this._lastLoginAt,
      roles: this._roles.map((role) => role.name),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt,
    };
  }
}
