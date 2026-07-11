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
  ConsentRecordEntity,
  CustomerEntity,
  PermissionEntity,
  RoleEntity,
  StaffUserEntity,
} from '../modules/auth/infrastructure/persistence';
import { AuditModule } from '../modules/audit';
import { AuthModule } from '../modules/auth';
import { CartModule } from '../modules/cart';
import { CatalogModule } from '../modules/catalog';
import { CustomerAdminModule } from '../modules/customer-admin';
import { HealthModule } from '../modules/health';
import { IamModule } from '../modules/iam';
import { InventoryModule } from '../modules/inventory';
import { NotificationsModule } from '../modules/notifications';
import { OrdersModule } from '../modules/orders';
import { ReturnsModule } from '../modules/returns';
import { OptimisticLockExceptionFilter } from '../common/filters';
import { DuplicateKeyExceptionFilter } from './filters/duplicate-key-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY)),
    DatabaseModule.forRoot([
      StaffUserEntity,
      RoleEntity,
      PermissionEntity,
      CustomerEntity,
      ConsentRecordEntity,
    ]),
    AuthModule,
    HealthModule,
    IamModule,
    CustomerAdminModule,
    CatalogModule,
    InventoryModule,
    CartModule,
    OrdersModule,
    ReturnsModule,
    NotificationsModule,
    AuditModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DuplicateKeyExceptionFilter },
    // Normalizes a gateway-local TypeORM optimistic-lock failure into the uniform
    // `409 { code: VERSION_MISMATCH, currentVersion }` (ADR-036 §3).
    { provide: APP_FILTER, useClass: OptimisticLockExceptionFilter },
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
