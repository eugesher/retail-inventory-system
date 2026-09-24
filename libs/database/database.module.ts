import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';

import { SnakeNamingStrategy } from './snake-naming.strategy';

@Module({})
export class DatabaseModule {
  public static forRoot(entities: TypeOrmModuleOptions['entities']): DynamicModule {
    return DatabaseModule.forRootWithUrl(entities, 'DATABASE_URL');
  }

  public static forRootWithUrl(
    entities: TypeOrmModuleOptions['entities'],
    urlEnvVar: string,
  ): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService): TypeOrmModuleOptions => ({
            type: 'mysql',
            url: configService.get<string>(urlEnvVar),
            logging: configService.get<boolean>('DATABASE_LOGGING'),
            synchronize: false,
            timezone: 'Z',
            entities,
            namingStrategy: new SnakeNamingStrategy(),
          }),
        }),
      ],
      exports: [TypeOrmModule],
    };
  }

  public static forFeature(entities: EntityClassOrSchema[]): DynamicModule {
    return TypeOrmModule.forFeature(entities);
  }
}
