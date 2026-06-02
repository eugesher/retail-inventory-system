import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { CatalogModule } from '../modules/catalog';

// Empty entity list — task-02 registers `ProductEntity` + `ProductVariantEntity`
// against this same single MySQL schema (the catalog tables live alongside the
// rest by deliberate choice; a dedicated schema is a Day-2 question).
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)),
    DatabaseModule.forRoot([]),
    CatalogModule,
  ],
})
export class AppModule {}
