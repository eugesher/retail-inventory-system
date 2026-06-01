import { PermissionCodeEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

interface IRoleProps {
  name: string;
  description?: string | null;
  permissions?: Iterable<PermissionCodeEnum>;
}

const ROLE_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

// Kebab-case name + set of permission codes. `permissions` is a Set so
// duplicate `addPermission(code)` calls collapse to a no-op without the
// caller having to dedupe first. `RoleEntity` flattens this to a join
// table at the persistence boundary; see `role.mapper.ts`.
export class RoleAggregate extends AggregateRoot<string> {
  private _name: string;
  private _description: string | null;
  private readonly _permissions: Set<PermissionCodeEnum>;

  private constructor(id: string, props: IRoleProps) {
    super(id);

    if (!props.name || !ROLE_NAME_REGEX.test(props.name)) {
      throw new Error(`RoleAggregate: name must match ${ROLE_NAME_REGEX.source}`);
    }

    this._name = props.name;
    this._description = props.description ?? null;
    this._permissions = new Set(props.permissions ?? []);
  }

  public static create(id: string, props: IRoleProps): RoleAggregate {
    return new RoleAggregate(id, props);
  }

  public static rehydrate(id: string, props: IRoleProps): RoleAggregate {
    return new RoleAggregate(id, props);
  }

  public get name(): string {
    return this._name;
  }

  public get description(): string | null {
    return this._description;
  }

  public get permissions(): ReadonlySet<PermissionCodeEnum> {
    return this._permissions;
  }

  public setDescription(description: string | null): void {
    this._description = description;
  }

  public addPermission(code: PermissionCodeEnum): void {
    this._permissions.add(code);
  }

  public removePermission(code: PermissionCodeEnum): void {
    this._permissions.delete(code);
  }

  public hasPermission(code: PermissionCodeEnum): boolean {
    return this._permissions.has(code);
  }
}
