import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { IAuthUserValidator } from '@retail-inventory-system/auth';
import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

import { CUSTOMER_REPOSITORY, ICustomerRepositoryPort } from '../ports/customer.repository.port';
import {
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports/staff-user.repository.port';

// Single validator for both subject kinds — staff first, customer on miss.
// The JWT envelope carries the same claims for both kinds (customer JWTs simply
// land with `roles: []` and `permissions: []`); no `subjectKind` discriminator
// is added to the token, so existing tokens issued before this rename continue
// to validate without re-issue.
@Injectable()
export class ValidateJwtSubjectUseCase implements IAuthUserValidator {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staff: IStaffUserRepositoryPort,
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
  ) {}

  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    const staffUser = await this.staff.findById(payload.sub);
    if (staffUser?.isActive) {
      return {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions: payload.permissions ?? [],
      };
    }

    const customer = await this.customers.findById(payload.sub);
    if (customer?.isActive) {
      return {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles,
        permissions: payload.permissions ?? [],
      };
    }

    throw new UnauthorizedException('Account is no longer active');
  }
}
