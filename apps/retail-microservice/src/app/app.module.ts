import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig, LoggerModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';

import { entities } from './common';
import { OrderModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    DatabaseModule.forRoot(entities),
    OrderModule,
  ],
})
export class AppModule {}
