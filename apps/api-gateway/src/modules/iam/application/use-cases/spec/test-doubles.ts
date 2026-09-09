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

// The real adapters hand back a RECONSTITUTED aggregate — `StaffUserTypeormRepository.save`
// ends in `StaffUserMapper.toDomain(reloaded)`, `BaseTypeormRepository.save` in
// `toDomain(saved)` — and a reconstituted aggregate carries no domain events. A double that
// returns its own argument therefore lets a spec assert something off a `save()` return that
// production can never deliver, and three specs in this folder used to do exactly that: they
// were green only because the double preserved object identity.
//
// The clone keeps the double honest and leaves the CALLER's aggregate untouched, which is also
// what the real adapter does — so the correct pattern (keep the mutated aggregate in a local,
// drain from that) still works here, and only the incorrect one fails.
interface IDrainable {
  pullDomainEvents(): unknown[];
}

const asReconstituted = <T extends IDrainable>(aggregate: T): T => {
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(aggregate) as object) as T,
    aggregate,
  );
  clone.pullDomainEvents();
  return clone;
};

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
    return Promise.resolve(asReconstituted(role));
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
    return Promise.resolve(asReconstituted(user));
  }

  // Arrangement only — NOT on the port (ADR-049). Drops the row so a spec can assert
  // that a token minted for a staff user who no longer exists is rejected.
  public remove(id: string): void {
    this.byId.delete(id);
  }
}
