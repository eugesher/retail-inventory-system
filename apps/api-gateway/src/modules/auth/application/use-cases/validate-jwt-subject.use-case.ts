import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { IAuthUserValidator } from '@retail-inventory-system/auth';
import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports';

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
    // Identity claims travel in the JWT itself (customer tokens simply carry
    // `roles: []` / `permissions: []`), so we only need to confirm an active
    // subject still exists — staff first, customer on miss. An existence check
    // avoids loading (and discarding) the full role/permission graph on every
    // authenticated request.
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
