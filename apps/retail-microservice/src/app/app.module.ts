import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  ConfigFactoryTokenEnum,
  ConfigModuleConfiguration,
  TypeormModuleConfiguration,
} from '@retail-inventory-system/config';
import { configObject } from '../config';
import { entities } from './common';
import { OrderModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration({
        token: ConfigFactoryTokenEnum.RETAIL_MICROSERVICE,
        configObject,
      }),
    ),
    TypeOrmModule.forRootAsync(new TypeormModuleConfiguration(entities)),
    OrderModule,
  ],
})
export class AppModule {}
