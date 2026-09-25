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
