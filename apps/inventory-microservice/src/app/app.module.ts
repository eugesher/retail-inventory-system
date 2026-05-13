import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { cacheModuleConfig } from '@retail-inventory-system/cache';
import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { stockEntities } from '../modules/stock/infrastructure/persistence';
import { StockModule } from '../modules/stock/infrastructure/stock.module';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.INVENTORY_MICROSERVICE)),
    DatabaseModule.forRoot(stockEntities),
    CacheModule.registerAsync(cacheModuleConfig),
    StockModule,
  ],
})
export class AppModule {}
