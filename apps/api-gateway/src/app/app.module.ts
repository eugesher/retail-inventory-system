import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CorrelationMiddleware } from '@retail-inventory-system/common';
import { ConfigFactoryTokenEnum, ConfigModuleConfiguration } from '@retail-inventory-system/config';
import { configObject } from '../config';
import { OrderModule, ProductModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot(
      new ConfigModuleConfiguration({
        token: ConfigFactoryTokenEnum.API_GATEWAY,
        configObject,
      }),
    ),
    OrderModule,
    ProductModule,
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
