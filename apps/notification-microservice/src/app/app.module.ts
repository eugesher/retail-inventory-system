import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ConfigFactoryTokenEnum, ConfigModuleConfiguration } from '@retail-inventory-system/config';
import { configObject } from '../config';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration(ConfigFactoryTokenEnum.NOTIFICATION_MICROSERVICE, configObject),
    ),
  ],
})
export class AppModule {}
