import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ConfigFactoryTokenEnum, ConfigModuleConfiguration } from '@retail-inventory-system/config';
import { configObject } from '../config';
import { ProductModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration(ConfigFactoryTokenEnum.API_GATEWAY, configObject),
    ),
    ProductModule,
  ],
})
export class AppModule {}
