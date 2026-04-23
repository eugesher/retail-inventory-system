import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';

import { AppNameEnum } from '@retail-inventory-system/common';
import {
  cacheModuleConfig,
  ConfigFactoryTokenEnum,
  ConfigModuleConfig,
  LoggerModuleConfig,
  TypeormModuleConfig,
} from '@retail-inventory-system/config';
import { configObject } from '../config';
import { entities } from './common';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfig({
        token: ConfigFactoryTokenEnum.INVENTORY_MICROSERVICE,
        configObject,
      }),
    ),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.INVENTORY_MICROSERVICE)),
    TypeOrmModule.forRootAsync(new TypeormModuleConfig(entities)),
    CacheModule.registerAsync(cacheModuleConfig),
    ProductStockModule,
  ],
})
export class AppModule {}
