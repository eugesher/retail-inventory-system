import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  AuditLogEntryView,
  DomainEventView,
  IAuditLogQueryPayload,
  ICorrelationTracePayload,
  ICorrelationTraceResult,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IAuditGatewayPort } from '../../application/ports';

@Injectable()
export class AuditRabbitmqAdapter implements IAuditGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.EVENT_STORE_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async queryEvents(payload: IDomainEventQueryPayload): Promise<IPage<DomainEventView>> {
    return firstValueFrom(
      this.client.send<IPage<DomainEventView>, IDomainEventQueryPayload>(
        ROUTING_KEYS.AUDIT_EVENT_QUERY,
        payload,
      ),
    );
  }

  public async queryEntries(payload: IAuditLogQueryPayload): Promise<IPage<AuditLogEntryView>> {
    return firstValueFrom(
      this.client.send<IPage<AuditLogEntryView>, IAuditLogQueryPayload>(
        ROUTING_KEYS.AUDIT_ENTRY_QUERY,
        payload,
      ),
    );
  }

  public async traceByCorrelation(
    payload: ICorrelationTracePayload,
  ): Promise<ICorrelationTraceResult> {
    return firstValueFrom(
      this.client.send<ICorrelationTraceResult, ICorrelationTracePayload>(
        ROUTING_KEYS.AUDIT_TRACE_BY_CORRELATION,
        payload,
      ),
    );
  }
}
