import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { IAuthUserValidator } from '@retail-inventory-system/auth';
import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

import { IUserRepositoryPort, USER_REPOSITORY } from '../ports/user.repository.port';

@Injectable()
export class ValidateUserUseCase implements IAuthUserValidator {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepositoryPort) {}

  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    const user = await this.users.findById(payload.sub);
    if (!user?.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }

    return {
      id: user.id,
      email: user.email,
      roles: user.roles.map((role) => role.value),
    };
  }
}
