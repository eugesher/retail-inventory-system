import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  IRoleRepositoryPort,
  IStaffUserRepositoryPort,
  ROLE_REPOSITORY,
  STAFF_USER_REPOSITORY,
  StaffUser,
} from '../../../auth';
import { IAssignStaffRoleCommand } from '../dto/assign-staff-role.command';

@Injectable()
export class AssignStaffRoleUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staffUsers: IStaffUserRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: IRoleRepositoryPort,
  ) {}

  public async execute(command: IAssignStaffRoleCommand): Promise<StaffUser> {
    if (command.roleNames.length === 0) {
      throw new BadRequestException('At least one role name is required');
    }

    const staffUser = await this.staffUsers.findById(command.staffUserId);
    if (!staffUser || staffUser.status === 'suspended') {
      throw new NotFoundException(`StaffUser ${command.staffUserId} not found`);
    }

    const resolved = await this.roles.findAllByNames(command.roleNames);
    if (resolved.length !== command.roleNames.length) {
      const found = new Set(resolved.map((r) => r.name));
      const missing = command.roleNames.filter((n) => !found.has(n));
      throw new BadRequestException(`Unknown role names: ${missing.join(', ')}`);
    }

    const previousRoleIds = new Set(staffUser.roles.map((r) => r.id));
    for (const role of resolved) {
      staffUser.assignRole(role);
    }
    const addedRoleNames = resolved.filter((r) => !previousRoleIds.has(r.id)).map((r) => r.name);

    if (addedRoleNames.length > 0) {
      staffUser.recordRolesAssigned(addedRoleNames);
    }

    return this.staffUsers.save(staffUser);
  }
}
