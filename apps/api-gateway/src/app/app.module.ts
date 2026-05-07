import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AppNameEnum, CorrelationMiddleware } from '@retail-inventory-system/common';
import { ConfigModuleConfig, LoggerModuleConfig } from '@retail-inventory-system/config';
import { OrderModule, ProductModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(new ConfigModuleConfig()),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
    OrderModule,
    ProductModule,
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
