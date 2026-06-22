import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  IInventoryStockLowEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { OPS_NOTIFICATIONS_EMAIL } from '../../application/ports';
import { RenderAndDispatchUseCase } from '../../application/use-cases';

// Consumes `inventory.stock.low` off `notification_events` and routes it through the
// template-driven `RenderAndDispatchUseCase` (it resolves the active template, persists a
// `queued` delivery BEFORE the `NOTIFIER` call, then flips the row — ADR-033).
//
// A low-stock alert is a SYSTEM/OPS notification, not a buyer one: there is no customer, so
// `recipientCustomerId` is `null` (the row is intentionally NOT deduped — ADR-033) and the
// recipient is the operations mailbox (`OPS_NOTIFICATIONS_EMAIL`). The reference key is the
// `(variantId, stockLocationId)` pair so the audit trail pins the alert to the exact level.
// `correlationId` is logged inline by the use case (ADR-011 §7).
@Controller()
export class InventoryEventsConsumer {
  constructor(
    @Inject(OPS_NOTIFICATIONS_EMAIL)
    private readonly opsEmail: string,
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
  ) {}

  @EventPattern(ROUTING_KEYS.INVENTORY_STOCK_LOW)
  public async onStockLow(@Payload() event: IInventoryStockLowEvent): Promise<void> {
    await this.renderAndDispatch.execute({
      eventType: ROUTING_KEYS.INVENTORY_STOCK_LOW,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: null,
      recipientAddress: this.opsEmail,
      eventReferenceType: 'stock-low',
      eventReferenceId: `${event.variantId}:${event.stockLocationId}`,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }
}
