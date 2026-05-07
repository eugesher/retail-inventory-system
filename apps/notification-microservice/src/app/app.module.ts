import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AppNameEnum } from '@retail-inventory-system/common';
import { ConfigModuleConfig, LoggerModuleConfig } from '@retail-inventory-system/config';

@Module({
  imports: [
    ConfigModule.forRoot(new ConfigModuleConfig()),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.NOTIFICATION_MICROSERVICE)),
  ],
})
export class AppModule {}
