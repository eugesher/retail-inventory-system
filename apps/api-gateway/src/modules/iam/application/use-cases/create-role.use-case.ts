import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import {
  IPermissionRepositoryPort,
  IRoleRepositoryPort,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  RoleAggregate,
} from '../../../auth';
import { ICreateRoleCommand } from '../dto';
import { assertPermissionsExist } from './assert-permissions-exist';

@Injectable()
export class CreateRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: IRoleRepositoryPort,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: IPermissionRepositoryPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
  ) {}

  public async execute(command: ICreateRoleCommand): Promise<RoleAggregate> {
    const dup = await this.roles.findByName(command.name);
    if (dup) {
      throw new ConflictException(`Role "${command.name}" already exists`);
    }

    await assertPermissionsExist(this.permissions, command.permissionCodes);

    const role = RoleAggregate.create(randomUUID(), {
      name: command.name,
      description: command.description ?? null,
      permissions: command.permissionCodes,
    });
    const saved = await this.roles.save(role);

    await this.audit.publish({
      name: 'RoleCreated',
      actorId: command.actorId ?? null,
      actorKind: command.actorId ? 'staff' : 'anonymous',
      targetId: saved.id,
      targetKind: 'role',
      payload: {
        name: saved.name,
        description: saved.description,
        permissionCodes: Array.from(saved.permissions),
      },
      correlationId: command.correlationId ?? null,
    });

    return saved;
  }
}
