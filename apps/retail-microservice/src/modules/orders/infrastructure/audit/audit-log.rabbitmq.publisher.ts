import { Injectable } from '@nestjs/common';

import {
  IAuditLogEvent,
  IAuditLogPublisher,
  toAuditStaffActionEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS, RisEventsMirrorPublisher } from '@retail-inventory-system/messaging';

@Injectable()
export class AuditLogRabbitmqPublisher implements IAuditLogPublisher {
  constructor(private readonly risEvents: RisEventsMirrorPublisher) {}

  public async publish(event: IAuditLogEvent): Promise<void> {
    await this.risEvents.mirror(ROUTING_KEYS.AUDIT_STAFF_ACTION, toAuditStaffActionEvent(event));
  }
}
