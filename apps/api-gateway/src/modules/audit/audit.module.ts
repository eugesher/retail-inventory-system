import { Module } from '@nestjs/common';

import { MicroserviceClientEventStoreModule } from '@retail-inventory-system/messaging';

import { AUDIT_GATEWAY_PORT } from './application/ports';
import {
  QueryEntriesUseCase,
  QueryEventsUseCase,
  TraceByCorrelationUseCase,
} from './application/use-cases';
import { AuditRabbitmqAdapter } from './infrastructure/messaging';
import { AuditController } from './presentation';

@Module({
  imports: [MicroserviceClientEventStoreModule],
  controllers: [AuditController],
  providers: [
    QueryEventsUseCase,
    QueryEntriesUseCase,
    TraceByCorrelationUseCase,
    { provide: AUDIT_GATEWAY_PORT, useClass: AuditRabbitmqAdapter },
  ],
})
export class AuditModule {}
