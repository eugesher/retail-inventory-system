import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../domain';
import { RoleEntity } from './role.entity';

export class RoleMapper {
  public static toDomain(entity: RoleEntity): RoleAggregate {
    const permissions = (entity.permissions ?? []).map((p) => p.code as PermissionCodeEnum);

    return RoleAggregate.rehydrate(entity.id, {
      name: entity.name,
      description: entity.description,
      permissions,
    });
  }
}
