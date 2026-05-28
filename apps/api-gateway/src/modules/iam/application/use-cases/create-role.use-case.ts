import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import {
  IPermissionRepositoryPort,
  IRoleRepositoryPort,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  RoleAggregate,
} from '../../../auth';
import { ICreateRoleCommand } from '../dto/create-role.command';

@Injectable()
export class CreateRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: IRoleRepositoryPort,
    @Inject(PERMISSION_REPOSITORY) private readonly permissions: IPermissionRepositoryPort,
  ) {}

  public async execute(command: ICreateRoleCommand): Promise<RoleAggregate> {
    const dup = await this.roles.findByName(command.name);
    if (dup) {
      throw new ConflictException(`Role "${command.name}" already exists`);
    }

    await this.assertPermissionsExist(command.permissionCodes);

    const role = RoleAggregate.create(randomUUID(), {
      name: command.name,
      description: command.description ?? null,
      permissions: command.permissionCodes,
    });
    return this.roles.save(role);
  }

  private async assertPermissionsExist(codes: PermissionCodeEnum[]): Promise<void> {
    if (codes.length === 0) return;
    const found = await this.permissions.findByCodes(codes);
    const foundSet = new Set(found.map((p) => p.code));
    const missing = codes.filter((c) => !foundSet.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown permission codes: ${missing.join(', ')}`);
    }
  }
}
