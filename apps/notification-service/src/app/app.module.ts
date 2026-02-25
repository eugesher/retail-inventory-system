import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ConfigModuleConfiguration } from '@retail-inventory/config';
import { configObject } from '../config';

@Module({
  imports: [
    ConfigModule.forRoot(new ConfigModuleConfiguration('notification-service', configObject)),
  ],
})
export class AppModule {}
