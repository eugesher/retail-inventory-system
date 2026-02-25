import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModuleConfiguration } from '@retail-inventory/config';
import { configObject, TypeormModuleConfiguration } from '../config';
import { entities } from './common/entities';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(new ConfigModuleConfiguration('inventory-service', configObject)),
    TypeOrmModule.forRootAsync(new TypeormModuleConfiguration(entities)),
    ProductStockModule,
  ],
})
export class AppModule {}
