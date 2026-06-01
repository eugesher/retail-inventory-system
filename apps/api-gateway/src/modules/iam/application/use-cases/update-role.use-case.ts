import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import {
  IPermissionRepositoryPort,
  IRoleRepositoryPort,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  RoleAggregate,
} from '../../../auth';
import { IUpdateRoleCommand } from '../dto';
import { assertPermissionsExist } from './assert-permissions-exist';

@Injectable()
export class UpdateRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: IRoleRepositoryPort,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: IPermissionRepositoryPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
  ) {}

  public async execute(command: IUpdateRoleCommand): Promise<RoleAggregate> {
    if (command.description === undefined && command.permissionCodes === undefined) {
      throw new BadRequestException('No-op patch');
    }

    const role = await this.roles.findById(command.id);
    if (!role) {
      throw new NotFoundException(`Role ${command.id} not found`);
    }

    if (command.description !== undefined) {
      role.setDescription(command.description ?? null);
      await this.roles.save(role);
    }

    let result = role;
    if (command.permissionCodes !== undefined) {
      await assertPermissionsExist(this.permissions, command.permissionCodes);
      result = await this.roles.replacePermissions(role, command.permissionCodes);
    }

    await this.audit.publish({
      name: 'RolePermissionsReplaced',
      actorId: command.actorId ?? null,
      actorKind: command.actorId ? 'staff' : 'anonymous',
      targetId: result.id,
      targetKind: 'role',
      payload: {
        name: result.name,
        description: result.description,
        permissionCodes: Array.from(result.permissions),
        descriptionUpdated: command.description !== undefined,
        permissionsReplaced: command.permissionCodes !== undefined,
      },
      correlationId: command.correlationId ?? null,
    });

    return result;
  }
}
