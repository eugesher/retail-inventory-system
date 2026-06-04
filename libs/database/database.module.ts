import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';

import { SnakeNamingStrategy } from './snake-naming.strategy';

@Module({})
export class DatabaseModule {
  public static forRoot(entities: TypeOrmModuleOptions['entities']): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService): TypeOrmModuleOptions => ({
            type: 'mysql',
            url: configService.get<string>('DATABASE_URL'),
            logging: configService.get<boolean>('DATABASE_LOGGING'),
            synchronize: false,
            // Pin the mysql2 driver to UTC so JS `Date`s are written and read as
            // UTC wall-clock — matching the MySQL server clock and SQL functions
            // like `UTC_TIMESTAMP()`. Without this the driver defaults to the
            // Node host's local timezone, storing local wall-clock and misreading
            // DB-generated (`CURRENT_TIMESTAMP`) values on a non-UTC host. The
            // pricing publish precondition probe compares stored `valid_from`
            // against `UTC_TIMESTAMP()`, so the two clocks must agree.
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
