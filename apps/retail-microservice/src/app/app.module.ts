import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { CartModule, cartEntities } from '../modules/cart';
import { OrdersModule, orderEntities } from '../modules/orders';
import { ReturnsModule, returnEntities } from '../modules/returns';

import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    DatabaseModule.forRoot([...cartEntities, ...orderEntities, ...returnEntities]),
    CartModule,
    OrdersModule,
    ReturnsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
