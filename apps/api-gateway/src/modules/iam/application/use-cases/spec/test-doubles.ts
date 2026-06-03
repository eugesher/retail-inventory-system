import {
  IAuditLogEvent,
  IAuditLogPublisher,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';

import {
  IPermissionRepositoryPort,
  IRoleRepositoryPort,
  IStaffUserRepositoryPort,
  PermissionAggregate,
  RoleAggregate,
  StaffUser,
} from '../../../../auth';

// Recording fake for IAuditLogPublisher — collects published events so specs
// can assert event-name + payload shape per audit point. Kept here (not
// re-exported from auth's test-doubles) because IAM specs live in a sibling
// module and the eslint boundaries rules forbid spec-to-sibling-module deep
// imports.
export class FakeAuditLogPublisher implements IAuditLogPublisher {
  public readonly published: IAuditLogEvent[] = [];

  public publish(event: IAuditLogEvent): Promise<void> {
    this.published.push(event);
    return Promise.resolve();
  }
}

export class InMemoryRoleRepository implements IRoleRepositoryPort {
  private byId = new Map<string, RoleAggregate>();

  public seed(role: RoleAggregate): void {
    this.byId.set(role.id, role);
  }

  public findById(id: string): Promise<RoleAggregate | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  public findByName(name: string): Promise<RoleAggregate | null> {
    for (const role of this.byId.values()) {
      if (role.name === name) return Promise.resolve(role);
    }
    return Promise.resolve(null);
  }

  public findAllByNames(names: string[]): Promise<RoleAggregate[]> {
    const out: RoleAggregate[] = [];
    for (const role of this.byId.values()) {
      if (names.includes(role.name)) out.push(role);
    }
    return Promise.resolve(out);
  }

  public findAll(): Promise<RoleAggregate[]> {
    return Promise.resolve(Array.from(this.byId.values()));
  }

  public save(role: RoleAggregate): Promise<RoleAggregate> {
    this.byId.set(role.id, role);
    return Promise.resolve(role);
  }

  public update(role: RoleAggregate, codes?: PermissionCodeEnum[]): Promise<RoleAggregate> {
    const stored = this.byId.get(role.id) ?? role;
    stored.setDescription(role.description);
    if (codes !== undefined) {
      for (const code of [...stored.permissions]) {
        stored.removePermission(code);
      }
      for (const code of codes) {
        stored.addPermission(code);
      }
    }
    this.byId.set(stored.id, stored);
    return Promise.resolve(stored);
  }
}

export class InMemoryPermissionRepository implements IPermissionRepositoryPort {
  private byCode = new Map<string, PermissionAggregate>();

  public seed(permission: PermissionAggregate): void {
    this.byCode.set(permission.code, permission);
  }

  public findAll(): Promise<PermissionAggregate[]> {
    return Promise.resolve(Array.from(this.byCode.values()));
  }

  public findByCodes(codes: string[]): Promise<PermissionAggregate[]> {
    const out: PermissionAggregate[] = [];
    for (const code of codes) {
      const p = this.byCode.get(code);
      if (p) out.push(p);
    }
    return Promise.resolve(out);
  }
}

export class InMemoryStaffUserRepository implements IStaffUserRepositoryPort {
  private byId = new Map<string, StaffUser>();

  public seed(user: StaffUser): void {
    this.byId.set(user.id, user);
  }

  public findByEmail(email: string): Promise<StaffUser | null> {
    const target = email.toLowerCase();
    for (const user of this.byId.values()) {
      if (user.email === target) return Promise.resolve(user);
    }
    return Promise.resolve(null);
  }

  public findById(id: string): Promise<StaffUser | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  public existsActiveById(id: string): Promise<boolean> {
    return Promise.resolve(this.byId.get(id)?.isActive ?? false);
  }

  public save(user: StaffUser): Promise<StaffUser> {
    this.byId.set(user.id, user);
    return Promise.resolve(user);
  }

  public softDelete(id: string): Promise<void> {
    this.byId.delete(id);
    return Promise.resolve();
  }
}
