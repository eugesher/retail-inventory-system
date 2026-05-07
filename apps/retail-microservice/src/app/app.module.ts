import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';

import { AppNameEnum } from '@retail-inventory-system/common';
import {
  configModuleConfig,
  LoggerModuleConfig,
  TypeormModuleConfig,
} from '@retail-inventory-system/config';
import { entities } from './common';
import { OrderModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    TypeOrmModule.forRootAsync(new TypeormModuleConfig(entities)),
    OrderModule,
  ],
})
export class AppModule {}
