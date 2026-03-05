import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleAsyncOptions, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { ConfigPropertyPathEnum } from '../configuration/enums';

export class TypeormModuleConfiguration implements TypeOrmModuleAsyncOptions {
  public readonly useFactory: TypeOrmModuleAsyncOptions['useFactory'];

  public readonly inject = [ConfigService];

  constructor(entities: TypeOrmModuleOptions['entities']) {
    this.useFactory = (configService: ConfigService): TypeOrmModuleOptions => {
      return {
        url: configService.get<string>('DATABASE_URL'),
        logging: configService.get<boolean>(ConfigPropertyPathEnum.GLOBAL_DATABASE_LOGGING),
        type: 'mysql',
        synchronize: false,
        entities,
        namingStrategy: new SnakeNamingStrategy(),
      };
    };
  }
}
