import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser } from '@retail-inventory-system/contracts';

import { ILoginCustomerCommand } from '../dto/login-customer.command';
import { CUSTOMER_REPOSITORY, ICustomerRepositoryPort } from '../ports/customer.repository.port';
import { IPasswordPort, PASSWORD_HASHER } from '../ports/password.port';
import { IIssuedTokens, ITokenPort, TOKEN_SERVICE } from '../ports/token.port';

export interface ILoginCustomerResult extends IIssuedTokens {
  user: ICurrentUser;
}

@Injectable()
export class LoginCustomerUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
    @InjectPinoLogger(LoginCustomerUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ILoginCustomerCommand): Promise<ILoginCustomerResult> {
    const email = command.email.trim().toLowerCase();
    const customer = await this.customers.findByEmail(email);

    if (!customer?.isActive) {
      this.logger.warn({ email }, 'CustomerLoginFailed: not found or inactive');
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await customer.validatePassword(command.password, this.hasher);
    if (!passwordValid) {
      this.logger.warn({ customerId: customer.id, email }, 'CustomerLoginFailed: bad password');
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessToken = await this.tokens.issueAccessToken({
      sub: customer.id,
      email: customer.email,
      roles: [],
      permissions: [],
      jti: accessJti,
    });
    const refreshToken = await this.tokens.issueRefreshToken({
      sub: customer.id,
      jti: refreshJti,
    });

    customer.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
    customer.recordLoggedIn();
    await this.customers.save(customer);

    this.logger.info({ customerId: customer.id }, 'CustomerLoggedIn');

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
      user: { id: customer.id, email: customer.email, roles: [], permissions: [] },
    };
  }
}
