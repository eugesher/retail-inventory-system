import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { JwtAuthGuard, RolesGuard } from '@retail-inventory-system/auth';
import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { CorrelationMiddleware, LoggerModuleConfig } from '@retail-inventory-system/observability';

import { UserEntity } from '../modules/auth/infrastructure/persistence/user.entity';
import { AuthModule } from '../modules/auth/infrastructure/auth.module';
import { InventoryModule } from '../modules/inventory/infrastructure/inventory.module';
import { RetailModule } from '../modules/retail/infrastructure/retail.module';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
    DatabaseModule.forRoot([UserEntity]),
    AuthModule,
    RetailModule,
    InventoryModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
