import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { IAuthUserValidator } from '@retail-inventory-system/auth';
import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports';

@Injectable()
export class ValidateJwtSubjectUseCase implements IAuthUserValidator {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staff: IStaffUserRepositoryPort,
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
  ) {}

  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    const active =
      (await this.staff.existsActiveById(payload.sub)) ||
      (await this.customers.existsAuthenticatableById(payload.sub));

    if (!active) {
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
