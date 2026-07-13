import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { catalogEntities, CatalogModule } from '../modules/catalog';
import { PricingModule, pricingEntities } from '../modules/pricing';

import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)),
    // The service owns one MySQL connection shared by both colocated modules, so the
    // two entity lists are merged into the single `forRoot`. Both are plain inferred
    // arrays of entity classes and spread directly — no cast (see the note on
    // `catalogEntities`).
    DatabaseModule.forRoot([...catalogEntities, ...pricingEntities]),
    CatalogModule,
    PricingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
