import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { IInventoryStockLowEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { SendLowStockAlertUseCase } from '../../application/use-cases';

@Controller()
export class InventoryEventsConsumer {
  constructor(private readonly useCase: SendLowStockAlertUseCase) {}

  @EventPattern(ROUTING_KEYS.INVENTORY_STOCK_LOW)
  public async onStockLow(@Payload() event: IInventoryStockLowEvent): Promise<void> {
    await this.useCase.execute(event);
  }
}
