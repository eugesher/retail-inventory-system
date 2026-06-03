import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { JwtAuthGuard, PermissionsGuard, RolesGuard } from '@retail-inventory-system/auth';
import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { CorrelationMiddleware, LoggerModuleConfig } from '@retail-inventory-system/observability';

import {
  CustomerEntity,
  PermissionEntity,
  RoleEntity,
  StaffUserEntity,
} from '../modules/auth/infrastructure/persistence';
import { AuthModule } from '../modules/auth';
import { CatalogModule } from '../modules/catalog';
import { IamModule } from '../modules/iam';
import { InventoryModule } from '../modules/inventory';
import { RetailModule } from '../modules/retail';
import { DuplicateKeyExceptionFilter } from './filters/duplicate-key-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
    DatabaseModule.forRoot([StaffUserEntity, RoleEntity, PermissionEntity, CustomerEntity]),
    AuthModule,
    IamModule,
    RetailModule,
    InventoryModule,
    CatalogModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DuplicateKeyExceptionFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
