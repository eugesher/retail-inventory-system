import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { IStaffUserRepositoryPort, STAFF_USER_REPOSITORY, StaffUser } from '../../../auth';
import { IRevokeStaffRoleCommand } from '../dto/revoke-staff-role.command';

@Injectable()
export class RevokeStaffRoleUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staffUsers: IStaffUserRepositoryPort,
  ) {}

  public async execute(command: IRevokeStaffRoleCommand): Promise<StaffUser> {
    const staffUser = await this.staffUsers.findById(command.staffUserId);
    if (!staffUser) {
      throw new NotFoundException(`StaffUser ${command.staffUserId} not found`);
    }

    const bound = staffUser.roles.find((r) => r.name === command.roleName);
    if (!bound) {
      throw new NotFoundException('Role not bound');
    }

    try {
      staffUser.revokeRole(bound);
    } catch (err) {
      // The aggregate refuses to remove the last role — surface as 409 so the
      // caller can disambiguate "you typed a wrong name" (404) from "this
      // operation would leave the user permission-less" (409).
      if (err instanceof Error && err.message.includes('cannot revoke the last remaining role')) {
        throw new ConflictException('Cannot revoke the last remaining role');
      }
      throw err;
    }

    staffUser.recordRoleRevoked(bound.name);
    return this.staffUsers.save(staffUser);
  }
}
