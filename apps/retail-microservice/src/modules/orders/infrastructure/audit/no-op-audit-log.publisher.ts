import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IAuditLogEvent, IAuditLogPublisher } from '@retail-inventory-system/contracts';

// Default retail-side `AUDIT_LOG_PUBLISHER` binding — a deliberate copy of the gateway's
// `NoOpAuditLogPublisher` (the retail microservice cannot import the gateway across the
// service boundary, ADR-004/017). Not a stub: semantics are "this deployment has no audit
// sink yet, so route the event to logs". The Pino context is fixed to 'AuditLog' so
// `grep AuditLog` over output isolates audit events cleanly even before a real publisher
// exists — a real RMQ/audit-store sink swaps in by rebinding `AUDIT_LOG_PUBLISHER` in
// `orders.module.ts`, with no use-case change.
//
// Refund operations are in the always-audit set (ADR-032), and auditing **retail-side**
// (inside Issue Refund) — not at a gateway endpoint — covers both the manual refund
// endpoint and the auto-refund-from-cancel consumer, which never crosses the gateway.
@Injectable()
export class NoOpAuditLogPublisher implements IAuditLogPublisher {
  constructor(@InjectPinoLogger('AuditLog') private readonly logger: PinoLogger) {}

  public publish(event: IAuditLogEvent): Promise<void> {
    this.logger.debug(
      {
        actorId: event.actorId,
        actorKind: event.actorKind,
        targetId: event.targetId,
        targetKind: event.targetKind,
        correlationId: event.correlationId,
        payload: event.payload,
      },
      event.name,
    );
    return Promise.resolve();
  }
}
