import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';

import { SnakeNamingStrategy } from './snake-naming.strategy';

@Module({})
export class DatabaseModule {
  // The default connection, opened from `DATABASE_URL` — the shared operational
  // `retail_db` every stateful service joins. Behaviour is delegated to
  // `forRootWithUrl` so the connection options (UTC pin, `synchronize` off, the
  // naming strategy) are defined once.
  public static forRoot(entities: TypeOrmModuleOptions['entities']): DynamicModule {
    return DatabaseModule.forRootWithUrl(entities, 'DATABASE_URL');
  }

  // A second root connection opened from a configurable env var. The event-store
  // microservice calls this with `EVENTSTORE_DATABASE_URL` to reach its isolated
  // `ris_eventstore` schema (ADR-034) — a separate logical database whose
  // write-heavy event firehose must not pressure the operational `retail_db`. The
  // connection options are identical to `forRoot`; only the URL source differs.
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
