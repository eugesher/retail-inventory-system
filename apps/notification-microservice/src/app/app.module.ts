import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AppNameEnum } from '@retail-inventory-system/common';
import {
  ConfigFactoryTokenEnum,
  ConfigModuleConfig,
  LoggerModuleConfig,
} from '@retail-inventory-system/config';
import { configObject } from '../config';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfig({
        token: ConfigFactoryTokenEnum.NOTIFICATION_MICROSERVICE,
        configObject,
      }),
    ),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.NOTIFICATION_MICROSERVICE)),
  ],
})
export class AppModule {}
