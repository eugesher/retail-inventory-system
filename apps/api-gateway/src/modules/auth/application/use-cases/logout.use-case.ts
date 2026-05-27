import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports/staff-user.repository.port';

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort,
    @InjectPinoLogger(LogoutUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.rotateRefreshTokenHash(null);
    await this.users.save(user);

    this.logger.info({ userId }, 'LogoutPerformed');
  }
}
