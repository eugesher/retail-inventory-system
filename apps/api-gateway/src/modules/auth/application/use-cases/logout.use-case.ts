import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import {
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports/staff-user.repository.port';

export interface ILogoutCommand {
  userId: string;
  correlationId?: string | null;
}

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
    @InjectPinoLogger(LogoutUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ILogoutCommand): Promise<void> {
    const user = await this.users.findById(command.userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.rotateRefreshTokenHash(null);
    await this.users.save(user);

    this.logger.info({ userId: command.userId }, 'LogoutPerformed');
    await this.audit.publish({
      name: 'LogoutPerformed',
      actorId: command.userId,
      actorKind: 'staff',
      targetId: command.userId,
      targetKind: 'staff-user',
      payload: {},
      correlationId: command.correlationId ?? null,
    });
  }
}
