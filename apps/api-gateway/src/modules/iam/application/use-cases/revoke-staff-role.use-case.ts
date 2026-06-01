import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import { IStaffUserRepositoryPort, STAFF_USER_REPOSITORY, StaffUser } from '../../../auth';
import { IRevokeStaffRoleCommand } from '../dto/revoke-staff-role.command';

@Injectable()
export class RevokeStaffRoleUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staffUsers: IStaffUserRepositoryPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
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
    const saved = await this.staffUsers.save(staffUser);

    await this.audit.publish({
      name: 'StaffUserRoleRevoked',
      actorId: command.actorId ?? null,
      actorKind: command.actorId ? 'staff' : 'anonymous',
      targetId: saved.id,
      targetKind: 'staff-user',
      payload: {
        revokedRoleName: bound.name,
        currentRoleNames: saved.roles.map((r) => r.name),
      },
      correlationId: command.correlationId ?? null,
    });

    return saved;
  }
}
