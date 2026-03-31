import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';

import { AppNameEnum } from '@retail-inventory-system/common';
import {
  ConfigFactoryTokenEnum,
  ConfigModuleConfiguration,
  LoggerConfig,
  TypeormModuleConfiguration,
} from '@retail-inventory-system/config';
import { configObject } from '../config';
import { entities } from './common';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration({
        token: ConfigFactoryTokenEnum.INVENTORY_MICROSERVICE,
        configObject,
      }),
    ),
    LoggerModule.forRoot(new LoggerConfig(AppNameEnum.INVENTORY_MICROSERVICE)),
    TypeOrmModule.forRootAsync(new TypeormModuleConfiguration(entities)),
    ProductStockModule,
  ],
})
export class AppModule {}
