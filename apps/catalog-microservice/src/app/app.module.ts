import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { catalogEntities, CatalogModule } from '../modules/catalog';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)),
    DatabaseModule.forRoot(catalogEntities),
    CatalogModule,
  ],
})
export class AppModule {}
