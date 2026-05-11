import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

import { AUTH_USER_VALIDATOR, IAuthUserValidator } from './auth-user-validator.port';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    @Inject(AUTH_USER_VALIDATOR) private readonly userValidator: IAuthUserValidator,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET')!,
    });
  }

  // Passport-jwt has already verified the signature and expiry by the time
  // this runs. The validator port lets the host app reject revoked or
  // soft-deleted accounts without leaking persistence into libs/auth.
  public async validate(payload: IJwtAccessPayload): Promise<ICurrentUser> {
    return this.userValidator.validate(payload);
  }
}
