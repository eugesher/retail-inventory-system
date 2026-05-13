import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { IRetailOrderCreatedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { SendOrderNotificationUseCase } from '../../application/use-cases';

@Controller()
export class OrderEventsConsumer {
  constructor(private readonly useCase: SendOrderNotificationUseCase) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_CREATED)
  public async onOrderCreated(@Payload() event: IRetailOrderCreatedEvent): Promise<void> {
    await this.useCase.execute(event);
  }
}
