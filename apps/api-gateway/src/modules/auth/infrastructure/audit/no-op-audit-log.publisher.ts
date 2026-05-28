import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IAuditLogEvent, IAuditLogPublisher } from '@retail-inventory-system/contracts';

// Default `AUDIT_LOG_PUBLISHER` binding. Not a stub — semantics are "this
// deployment has no audit log yet, so route the event to logs". The Pino
// context is fixed to 'AuditLog' so `grep AuditLog` over dev output isolates
// audit events cleanly even before the real publisher (epic-11) exists.
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
