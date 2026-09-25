import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICatalogVariantCreatedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { AutoInitStockLevelUseCase } from '../../application/use-cases';

@Controller()
export class CatalogEventsConsumer {
  constructor(
    private readonly autoInitStockLevel: AutoInitStockLevelUseCase,
    @InjectPinoLogger(CatalogEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.CATALOG_VARIANT_CREATED)
  public async onVariantCreated(@Payload() event: ICatalogVariantCreatedEvent): Promise<void> {
    this.logger.info(
      { correlationId: event.correlationId, variantId: event.variantId, sku: event.sku },
      'Consuming catalog.variant.created',
    );

    await this.autoInitStockLevel.execute(event);
  }
}
