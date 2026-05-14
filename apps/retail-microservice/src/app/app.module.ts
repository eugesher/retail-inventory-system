import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { OrdersModule } from '../modules/orders/infrastructure/orders.module';
import { orderEntities } from '../modules/orders/infrastructure/persistence';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    DatabaseModule.forRoot(orderEntities),
    OrdersModule,
  ],
})
export class AppModule {}
