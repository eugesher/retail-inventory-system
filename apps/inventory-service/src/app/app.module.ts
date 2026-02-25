import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { configModuleOptions, TypeormModuleConfiguration } from '../config';
import { entities } from './common/entities';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(new TypeormModuleConfiguration(entities)),
    ProductStockModule,
  ],
})
export class AppModule {}
