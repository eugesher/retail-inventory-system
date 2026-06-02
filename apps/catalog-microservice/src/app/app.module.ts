import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { CatalogModule } from '../modules/catalog';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)),
    CatalogModule,
  ],
})
export class AppModule {}
