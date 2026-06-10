import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { Customer } from '../../domain';
import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IPasswordPort,
  ITokenPort,
  PASSWORD_HASHER,
  TOKEN_SERVICE,
} from '../ports';

export interface ICreateGuestSessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  customerId: string;
}

// Mints a guest-tier session (Q1/Q7). The system's auth primitive is the bearer
// token, so a guest-tier token replaces the conventional session cookie: a guest
// is a real, logged-in-able `Customer` row (`status='guest'`, `password_hash` NULL —
// every cart/order has a Customer row, guest included). The issued access+refresh
// pair carries the customer-tier claims (`roles:[] / permissions:[]`,
// `sub = guestCustomerId`), so the guest then hits the protected cart routes
// uniformly. The returned `customerId` is the proof the client later presents as
// `fromCustomerId` when claiming the cart into a registered account.
//
// `ValidateJwtSubjectUseCase` accepts `status IN ('active','guest')`, so this
// token validates; only suspended/deleted are barred.
@Injectable()
export class CreateGuestSessionUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
    @InjectPinoLogger(CreateGuestSessionUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(correlationId?: string): Promise<ICreateGuestSessionResult> {
    const id = randomUUID();
    // A synthetic, per-guest-unique email satisfies the `Customer` email
    // invariant + the table's UNIQUE(email) without colliding across guests; it
    // is never a deliverable address (the `.local` TLD signals that).
    const email = `guest-${id}@guest.local`;

    const guest = Customer.register(id, {
      email,
      passwordHash: null,
      status: 'guest',
      firstName: null,
      lastName: null,
      phone: null,
      emailVerifiedAt: null,
    });

    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessToken = await this.tokens.issueAccessToken({
      sub: id,
      email,
      roles: [],
      permissions: [],
      jti: accessJti,
    });
    const refreshToken = await this.tokens.issueRefreshToken({ sub: id, jti: refreshJti });

    // Rotate the live refresh-token hash onto the row, exactly like
    // `LoginCustomerUseCase`, so the guest can refresh and logout uniformly.
    guest.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
    await this.customers.save(guest);

    this.logger.info({ correlationId, customerId: id }, 'GuestSessionCreated');

    return {
      accessToken,
      refreshToken,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
      customerId: id,
    };
  }
}
