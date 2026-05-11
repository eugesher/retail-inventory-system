import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

import { IPasswordPort } from '../../application/ports/password.port';

@Injectable()
export class Argon2PasswordAdapter implements IPasswordPort {
  private readonly options: argon2.Options;

  constructor(configService: ConfigService) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: configService.get<number>('AUTH_ARGON2_MEMORY_COST'),
      timeCost: configService.get<number>('AUTH_ARGON2_TIME_COST'),
      parallelism: configService.get<number>('AUTH_ARGON2_PARALLELISM'),
    };
  }

  public hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  public async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
