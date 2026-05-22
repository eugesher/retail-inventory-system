import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { CacheModule } from '@retail-inventory-system/cache';
import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { stockEntities, StockModule } from '../modules/stock';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.INVENTORY_MICROSERVICE)),
    DatabaseModule.forRoot(stockEntities),
    CacheModule,
    StockModule,
  ],
})
export class AppModule {}
