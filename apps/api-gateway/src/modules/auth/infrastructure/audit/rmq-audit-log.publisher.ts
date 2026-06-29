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

// The real `AUDIT_LOG_PUBLISHER` binding for the api-gateway `auth`/`iam` audit
// points (ADR-035) — replaces the former log-only no-op. It maps the in-process
// `IAuditLogEvent` produced at the call site into the `IAuditStaffActionEvent`
// wire shape and emits it onto the `ris.events` topic exchange under
// `audit.staff.action`, where the event store's audit-log ingest captures it.
//
// The held `ClientProxy` is the `RIS_EVENTS_PUBLISHER` topic-exchange client; the
// first `emit` argument is the AMQP topic routing key (the client runs with
// `wildcards: true` against the named `ris.events` exchange). Per ADR-020 the
// publish is best-effort and post-commit: a rejected `emit` is warn-logged and
// swallowed so a broker hiccup never blocks the mutation that already happened
// (login, role assignment, …). Call sites are unchanged — they still build the
// same `IAuditLogEvent`; only the binding swapped from transport-less logging to
// this RMQ adapter.
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
      // Best-effort post-commit fan-out (ADR-020): never rethrow — the audited
      // mutation already committed; a dropped audit emit must not surface to the
      // caller. The event-name + correlation id ride the warn line so the drop is
      // reconstructable from logs.
      this.logger.warn(
        { action: wire.action, correlationId: wire.correlationId, err: error as Error },
        'Failed to publish audit.staff.action onto ris.events',
      );
    }
  }

  // `IAuditLogEvent` → `IAuditStaffActionEvent` (ADR-035). The before/after
  // convention: when the call site supplies explicit `before`/`after` payload
  // keys use them, otherwise record the whole payload as `after` and leave
  // `before` null. `ipAddress` is always null — no call site captures it today.
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
