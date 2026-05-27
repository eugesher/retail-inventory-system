import { PermissionCodeEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

interface IPermissionProps {
  code: PermissionCodeEnum | string;
  description?: string | null;
}

// `<resource>:<action>` lowercase-kebab — matches every value of
// `PermissionCodeEnum`. The regex stays in the domain (not the entity)
// so the invariant is enforced even when the aggregate is constructed
// from a non-enum string (e.g. seed data, future admin tooling).
export const PERMISSION_CODE_REGEX = /^[a-z][a-z-]*:[a-z][a-z-]*$/;

export class PermissionAggregate extends AggregateRoot<string> {
  private _code: PermissionCodeEnum;
  private _description: string | null;

  private constructor(id: string, props: IPermissionProps) {
    super(id);

    if (!props.code || !PERMISSION_CODE_REGEX.test(props.code)) {
      throw new Error(`PermissionAggregate: code must match ${PERMISSION_CODE_REGEX.source}`);
    }

    this._code = props.code as PermissionCodeEnum;
    this._description = props.description ?? null;
  }

  public static create(id: string, props: IPermissionProps): PermissionAggregate {
    return new PermissionAggregate(id, props);
  }

  public static rehydrate(id: string, props: IPermissionProps): PermissionAggregate {
    return new PermissionAggregate(id, props);
  }

  public get code(): PermissionCodeEnum {
    return this._code;
  }

  public get description(): string | null {
    return this._description;
  }
}
