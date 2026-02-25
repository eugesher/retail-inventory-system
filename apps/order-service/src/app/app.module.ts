import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ConfigFactoryTokenEnum, ConfigModuleConfiguration } from '@retail-inventory/config';
import { configObject } from '../config';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration(ConfigFactoryTokenEnum.ORDER_SERVICE, configObject),
    ),
  ],
})
export class AppModule {}
