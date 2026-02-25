import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleAsyncOptions, TypeOrmModuleOptions } from '@nestjs/typeorm';

export class TypeormModuleConfiguration implements TypeOrmModuleAsyncOptions {
  public readonly useFactory: TypeOrmModuleAsyncOptions['useFactory'];

  public readonly inject = [ConfigService];

  constructor(entities: TypeOrmModuleOptions['entities']) {
    this.useFactory = (configService: ConfigService): TypeOrmModuleOptions => ({
      url: configService.get<string>('DATABASE_URL'),
      logging: configService.get<boolean>('global.database-logging'),
      type: 'mysql',
      synchronize: false,
      entities,
    });
  }
}
