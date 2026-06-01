import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import { StaffUser } from '../../domain/staff-user.model';
import {
  IPasswordPort,
  IRoleRepositoryPort,
  IStaffUserRepositoryPort,
  PASSWORD_HASHER,
  ROLE_REPOSITORY,
  STAFF_USER_REPOSITORY,
} from '../ports';

interface IRegisterStaffUserCommand {
  email: string;
  password: string;
  roleNames: string[];
  actorId?: string | null;
  correlationId?: string | null;
}

@Injectable()
export class RegisterStaffUserUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: IRoleRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
  ) {}

  public async execute(command: IRegisterStaffUserCommand): Promise<StaffUser> {
    const normalizedEmail = command.email.trim().toLowerCase();

    if (!command.roleNames || command.roleNames.length === 0) {
      throw new BadRequestException('At least one role name is required');
    }

    const existing = await this.users.findByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException('A staff user with that email already exists');
    }

    const resolvedRoles = await this.roles.findAllByNames(command.roleNames);
    if (resolvedRoles.length !== command.roleNames.length) {
      const found = new Set(resolvedRoles.map((r) => r.name));
      const missing = command.roleNames.filter((name) => !found.has(name));
      throw new BadRequestException(`Unknown role names: ${missing.join(', ')}`);
    }

    const passwordHash = await this.hasher.hash(command.password);
    const staffUser = StaffUser.register(randomUUID(), {
      email: normalizedEmail,
      passwordHash,
      roles: resolvedRoles,
    });

    const saved = await this.users.save(staffUser);

    await this.audit.publish({
      name: 'StaffUserRegistered',
      actorId: command.actorId ?? null,
      actorKind: command.actorId ? 'staff' : 'anonymous',
      targetId: saved.id,
      targetKind: 'staff-user',
      payload: { email: saved.email, roleNames: command.roleNames },
      correlationId: command.correlationId ?? null,
    });

    return saved;
  }
}
