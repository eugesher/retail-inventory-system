import { DeepPartial } from 'typeorm';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleVO } from '../../domain/role.model';
import { User } from '../../domain/user.model';
import { UserEntity } from './user.entity';

export class UserMapper {
  public static toDomain(entity: UserEntity): User {
    const roles = entity.roles
      .filter((role): role is RoleEnum => Object.values(RoleEnum).includes(role as RoleEnum))
      .map((role) => new RoleVO(role));

    return User.rehydrate(entity.id, {
      email: entity.email,
      passwordHash: entity.passwordHash,
      roles,
      refreshTokenHash: entity.refreshTokenHash,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      deletedAt: entity.deletedAt,
    });
  }

  public static toEntity(user: User): DeepPartial<UserEntity> {
    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      roles: user.roles.map((role) => role.value),
      refreshTokenHash: user.refreshTokenHash,
    };
  }
}
