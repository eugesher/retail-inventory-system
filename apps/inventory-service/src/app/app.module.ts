import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { configModuleOptions, typeormModuleOptions } from '../config';
import { ProductStockModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeormModuleOptions),
    ProductStockModule,
  ],
})
export class AppModule {}
