import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  AUDIT_LOG_PUBLISHER,
  IAuditLogPublisher,
  ICurrentUser,
} from '@retail-inventory-system/contracts';

import { ILoginCustomerCommand } from '../dto';
import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IIssuedTokens,
  IPasswordPort,
  ITokenPort,
  PASSWORD_HASHER,
  TOKEN_SERVICE,
} from '../ports';

interface ILoginCustomerResult extends IIssuedTokens {
  user: ICurrentUser;
}

@Injectable()
export class LoginCustomerUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
    @InjectPinoLogger(LoginCustomerUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ILoginCustomerCommand): Promise<ILoginCustomerResult> {
    const email = command.email.trim().toLowerCase();
    const correlationId = command.correlationId ?? null;
    const customer = await this.customers.findByEmail(email);

    if (!customer?.isActive) {
      this.logger.warn({ email }, 'CustomerLoginFailed: not found or inactive');
      await this.audit.publish({
        name: 'CustomerLoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: null,
        targetKind: null,
        payload: { email, reason: 'customer-not-found' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await customer.validatePassword(command.password, this.hasher);
    if (!passwordValid) {
      this.logger.warn({ customerId: customer.id, email }, 'CustomerLoginFailed: bad password');
      await this.audit.publish({
        name: 'CustomerLoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: customer.id,
        targetKind: 'customer',
        payload: { email, reason: 'bad-password' },
        correlationId,
      });
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
    await this.audit.publish({
      name: 'CustomerLoggedIn',
      actorId: customer.id,
      actorKind: 'customer',
      targetId: customer.id,
      targetKind: 'customer',
      payload: { email: customer.email },
      correlationId,
    });

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
      user: { id: customer.id, email: customer.email, roles: [], permissions: [] },
    };
  }
}
