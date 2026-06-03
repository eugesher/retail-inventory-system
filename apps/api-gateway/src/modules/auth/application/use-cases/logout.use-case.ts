import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports';
import { resolveAuthSubject } from './resolve-auth-subject';

interface ILogoutCommand {
  userId: string;
  correlationId?: string | null;
}

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staff: IStaffUserRepositoryPort,
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
    @InjectPinoLogger(LogoutUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ILogoutCommand): Promise<void> {
    // Both subject kinds share `/auth/logout`, so resolve staff-then-customer.
    const resolved = await resolveAuthSubject(this.staff, this.customers, command.userId);
    if (!resolved) {
      throw new NotFoundException('User not found');
    }

    resolved.subject.rotateRefreshTokenHash(null);
    await resolved.persist();

    this.logger.info({ userId: command.userId }, 'LogoutPerformed');
    await this.audit.publish({
      name: 'LogoutPerformed',
      actorId: command.userId,
      actorKind: resolved.actorKind,
      targetId: command.userId,
      targetKind: resolved.targetKind,
      payload: {},
      correlationId: command.correlationId ?? null,
    });
  }
}
