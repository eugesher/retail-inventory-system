import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { IAuthUserValidator } from '@retail-inventory-system/auth';
import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

import {
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports/staff-user.repository.port';

@Injectable()
export class ValidateStaffUserUseCase implements IAuthUserValidator {
  constructor(@Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort) {}

  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    const user = await this.users.findById(payload.sub);
    if (!user?.isActive) {
      throw new UnauthorizedException('Account is no longer active');
    }

    return {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
      permissions: payload.permissions ?? [],
    };
  }
}
