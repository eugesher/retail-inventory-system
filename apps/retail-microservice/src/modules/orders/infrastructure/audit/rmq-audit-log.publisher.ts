import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';

import {
  IAuditLogEvent,
  IAuditLogPublisher,
  IAuditStaffActionEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

// The real retail-side `AUDIT_LOG_PUBLISHER` binding (ADR-035) — a deliberate copy
// of the gateway's `RmqAuditLogPublisher` (the retail microservice cannot import
// the gateway across the service boundary, ADR-004/017). It replaces the former
// log-only no-op and covers the always-audit money movements: `IssueRefundUseCase`
// emits `RefundIssued` / `RefundFailed` (ADR-032), for both the manual refund and
// the auto-refund-from-cancel consumer (which never crosses the gateway).
//
// It maps the in-process `IAuditLogEvent` into the `IAuditStaffActionEvent` wire
// shape and emits it onto the `ris.events` topic exchange under
// `audit.staff.action` (the held `ClientProxy` is the `RIS_EVENTS_PUBLISHER`
// topic-exchange client; the first `emit` arg is the AMQP routing key). Per
// ADR-020 the publish is best-effort post-commit — a rejected `emit` is
// warn-logged and swallowed; the refund already committed, so a dropped audit emit
// must never surface to the caller.
@Injectable()
export class RmqAuditLogPublisher implements IAuditLogPublisher {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER)
    private readonly risEventsClient: ClientProxy,
    @InjectPinoLogger('AuditLog') private readonly logger: PinoLogger,
  ) {}

  public async publish(event: IAuditLogEvent): Promise<void> {
    const wire = this.toWire(event);

    try {
      await firstValueFrom(
        this.risEventsClient.emit<void, IAuditStaffActionEvent>(
          ROUTING_KEYS.AUDIT_STAFF_ACTION,
          wire,
        ),
      );
    } catch (error) {
      this.logger.warn(
        { action: wire.action, correlationId: wire.correlationId, err: error as Error },
        'Failed to publish audit.staff.action onto ris.events',
      );
    }
  }

  // `IAuditLogEvent` → `IAuditStaffActionEvent` (ADR-035). When the refund call
  // site supplies explicit `before`/`after` payload keys use them; otherwise the
  // whole structured payload becomes `after` and `before` is null. `ipAddress` is
  // always null — no call site captures it today.
  private toWire(event: IAuditLogEvent): IAuditStaffActionEvent {
    const before = (event.payload.before as Record<string, unknown> | undefined) ?? null;
    const after =
      (event.payload.after as Record<string, unknown> | undefined) ?? event.payload ?? null;

    return {
      actorId: event.actorId,
      actorType: event.actorKind === 'staff' ? 'staff-user' : 'system',
      action: event.name,
      entityType: event.targetKind,
      entityId: event.targetId,
      before,
      after,
      occurredAt: (event.occurredAt ?? new Date()).toISOString(),
      ipAddress: null,
      correlationId: event.correlationId ?? '',
      eventVersion: 'v1',
    };
  }
}
