import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { auditAndEventsEntities, AuditAndEventsModule } from '../modules/audit-and-events';

import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.EVENT_STORE_MICROSERVICE)),
    DatabaseModule.forRootWithUrl(auditAndEventsEntities, 'EVENTSTORE_DATABASE_URL'),
    AuditAndEventsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
