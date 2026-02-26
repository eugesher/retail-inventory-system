import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigFactoryTokenEnum, ConfigModuleConfiguration } from '@retail-inventory-system/config';
import { configObject, TypeormModuleConfiguration } from '../config';
import { entities } from './common/entities';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration(ConfigFactoryTokenEnum.INVENTORY_SERVICE, configObject),
    ),
    TypeOrmModule.forRootAsync(new TypeormModuleConfiguration(entities)),
    ProductStockModule,
  ],
})
export class AppModule {}
