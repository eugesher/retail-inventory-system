import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { IUserRepositoryPort, USER_REPOSITORY } from '../ports/user.repository.port';

@Injectable()
export class LogoutUseCase {
  private readonly logger = new Logger(LogoutUseCase.name);

  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepositoryPort) {}

  public async execute(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.rotateRefreshTokenHash(null);
    await this.users.save(user);

    this.logger.log({ userId }, 'LogoutPerformed');
  }
}
