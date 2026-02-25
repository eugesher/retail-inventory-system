import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ConfigModuleConfiguration } from '@retail-inventory/config';
import { configObject } from '../config';
import { ProductModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(new ConfigModuleConfiguration('api-gateway', configObject)),
    ProductModule,
  ],
})
export class AppModule {}
