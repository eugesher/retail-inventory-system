import { DeepPartial } from 'typeorm';

import { StaffUser } from '../../domain/staff-user.model';
import { RoleEntity } from './role.entity';
import { RoleMapper } from './role.mapper';
import { StaffUserEntity } from './staff-user.entity';

export class StaffUserMapper {
  public static toDomain(entity: StaffUserEntity): StaffUser {
    const roles = (entity.roles ?? []).map((role) => RoleMapper.toDomain(role));

    return StaffUser.rehydrate(entity.id, {
      email: entity.email,
      passwordHash: entity.passwordHash,
      roles,
      status: entity.status,
      lastLoginAt: entity.lastLoginAt,
      refreshTokenHash: entity.refreshTokenHash,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      deletedAt: entity.deletedAt,
    });
  }

  public static toEntity(user: StaffUser): DeepPartial<StaffUserEntity> {
    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      refreshTokenHash: user.refreshTokenHash,
      roles: user.roles.map((role) => ({ id: role.id }) as DeepPartial<RoleEntity>),
    };
  }
}
