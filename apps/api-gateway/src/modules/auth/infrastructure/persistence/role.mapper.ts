import { DeepPartial } from 'typeorm';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../domain';
import { PermissionEntity } from './permission.entity';
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

  // Returns a partial — the join-table write goes through
  // `repository.save(...)` with the relation already populated.
  public static toEntity(aggregate: RoleAggregate): DeepPartial<RoleEntity> {
    return {
      id: aggregate.id,
      name: aggregate.name,
      description: aggregate.description,
      permissions: Array.from(aggregate.permissions).map(
        (code) => ({ code }) as DeepPartial<PermissionEntity>,
      ),
    };
  }
}
