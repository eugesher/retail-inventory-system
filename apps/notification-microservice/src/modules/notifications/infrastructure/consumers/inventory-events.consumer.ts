import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  IInventoryStockLowEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { OPS_NOTIFICATIONS_EMAIL } from '../../application/ports';
import { RenderAndDispatchUseCase } from '../../application/use-cases';

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
