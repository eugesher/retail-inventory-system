import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { CorrelationMiddleware, LoggerModuleConfig } from '@retail-inventory-system/observability';

import { InventoryModule } from '../modules/inventory/infrastructure/inventory.module';
import { RetailModule } from '../modules/retail/infrastructure/retail.module';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
    RetailModule,
    InventoryModule,
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
