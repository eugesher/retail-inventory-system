import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { cacheModuleConfig } from '@retail-inventory-system/cache';
import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { entities } from './common';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.INVENTORY_MICROSERVICE)),
    DatabaseModule.forRoot(entities),
    CacheModule.registerAsync(cacheModuleConfig),
    ProductStockModule,
  ],
})
export class AppModule {}
