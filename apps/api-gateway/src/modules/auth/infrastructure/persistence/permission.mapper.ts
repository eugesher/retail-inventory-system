import { PermissionAggregate } from '../../domain';
import { PermissionEntity } from './permission.entity';

export class PermissionMapper {
  public static toDomain(entity: PermissionEntity): PermissionAggregate {
    return PermissionAggregate.rehydrate(entity.id, {
      code: entity.code,
      description: entity.description,
    });
  }
}
