import { DeepPartial } from 'typeorm';

import { PermissionAggregate } from '../../domain/permission.aggregate';
import { PermissionEntity } from './permission.entity';

export class PermissionMapper {
  public static toDomain(entity: PermissionEntity): PermissionAggregate {
    return PermissionAggregate.rehydrate(entity.id, {
      code: entity.code,
      description: entity.description,
    });
  }

  public static toEntity(aggregate: PermissionAggregate): DeepPartial<PermissionEntity> {
    return {
      id: aggregate.id,
      code: aggregate.code,
      description: aggregate.description,
    };
  }
}
