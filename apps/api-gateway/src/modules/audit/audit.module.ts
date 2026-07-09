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

// Gateway-side port→adapter module fronting the event store's three `audit.*` query RPCs
// over HTTP at `/api/audit` (ADR-009 / ADR-039). It has no `domain/`: the gateway holds
// no audit state, and both logs live in the event store's own `ris_eventstore` schema
// (ADR-034) — a schema this deployable deliberately never connects to.
//
// `MicroserviceClientEventStoreModule` supplies the `EVENT_STORE_MICROSERVICE` client
// against `event_store_query_queue`. `AuditRabbitmqAdapter` (the sole `ClientProxy`
// holder) backs `AUDIT_GATEWAY_PORT`; the three thin use cases and the controller depend
// on the port symbol only.
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
