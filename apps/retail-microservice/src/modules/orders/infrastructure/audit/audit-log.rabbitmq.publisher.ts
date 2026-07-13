import { Injectable } from '@nestjs/common';

import {
  IAuditLogEvent,
  IAuditLogPublisher,
  toAuditStaffActionEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS, RisEventsMirrorPublisher } from '@retail-inventory-system/messaging';

// The real retail-side `AUDIT_LOG_PUBLISHER` binding (ADR-035) — a deliberate per-service
// copy of the gateway's `AuditLogRabbitmqPublisher` (the retail microservice cannot import the
// gateway across the service boundary, ADR-004/017). It replaces the former log-only no-op
// and covers the always-audit money movements: `IssueRefundUseCase` emits `RefundIssued` /
// `RefundFailed` (ADR-032), for both the manual refund and the auto-refund-from-cancel
// consumer (which never crosses the gateway).
//
// Both the wire mapping (`toAuditStaffActionEvent`) and the best-effort emit
// (`RisEventsMirrorPublisher.mirror`, which warn-logs + swallows a rejected emit, ADR-020)
// are shared library code, so this binding is a thin map-then-mirror shell — a dropped
// audit emit never surfaces to the caller whose refund already committed.
@Injectable()
export class AuditLogRabbitmqPublisher implements IAuditLogPublisher {
  constructor(private readonly risEvents: RisEventsMirrorPublisher) {}

  public async publish(event: IAuditLogEvent): Promise<void> {
    await this.risEvents.mirror(ROUTING_KEYS.AUDIT_STAFF_ACTION, toAuditStaffActionEvent(event));
  }
}
