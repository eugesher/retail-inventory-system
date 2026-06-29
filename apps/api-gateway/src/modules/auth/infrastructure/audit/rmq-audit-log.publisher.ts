import { Injectable } from '@nestjs/common';

import {
  IAuditLogEvent,
  IAuditLogPublisher,
  toAuditStaffActionEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS, RisEventsMirrorPublisher } from '@retail-inventory-system/messaging';

// The real `AUDIT_LOG_PUBLISHER` binding for the api-gateway `auth`/`iam` audit points
// (ADR-035) — replaces the former log-only no-op. It maps the in-process `IAuditLogEvent`
// to the `IAuditStaffActionEvent` wire shape (the shared `toAuditStaffActionEvent` mapper)
// and mirrors it onto the `ris.events` topic exchange under `audit.staff.action`, where
// the event store's audit-log ingest captures it.
//
// The emit goes through the shared `RisEventsMirrorPublisher`, which already owns the
// best-effort post-commit posture (ADR-020): it awaits the broker ack, never retries, and
// warn-logs + swallows its own rejection — so a broker hiccup never blocks the mutation
// that already committed (login, role assignment, …). Call sites are unchanged.
@Injectable()
export class RmqAuditLogPublisher implements IAuditLogPublisher {
  constructor(private readonly risEvents: RisEventsMirrorPublisher) {}

  public async publish(event: IAuditLogEvent): Promise<void> {
    await this.risEvents.mirror(ROUTING_KEYS.AUDIT_STAFF_ACTION, toAuditStaffActionEvent(event));
  }
}
