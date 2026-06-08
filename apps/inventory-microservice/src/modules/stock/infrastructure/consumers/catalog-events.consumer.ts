import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICatalogVariantCreatedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { AutoInitStockLevelUseCase } from '../../application/use-cases';

// RMQ subscriber for cross-service catalog events landing on `inventory_queue`.
// A thin infrastructure adapter (ADR-011 §4) — it translates the wire payload
// into a transport-free use-case call and nothing else. Lives under
// `infrastructure/consumers/`, never `presentation/` (which is HTTP).
//
// The catalog publisher emits `catalog.variant.created` through the
// `INVENTORY_MICROSERVICE` client, so the event arrives on this service's own
// queue and this `@EventPattern` dispatches it (ADR-008 / ADR-020 —
// producer-targets-consumer-queue, default exchange only).
@Controller()
export class CatalogEventsConsumer {
  constructor(
    private readonly autoInitStockLevel: AutoInitStockLevelUseCase,
    @InjectPinoLogger(CatalogEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.CATALOG_VARIANT_CREATED)
  public async onVariantCreated(@Payload() event: ICatalogVariantCreatedEvent): Promise<void> {
    // `correlationId` rides inline — `@EventPattern` handlers are not
    // request-scoped, so `PinoLogger.assign()` would throw (ADR-011 §7).
    this.logger.info(
      { correlationId: event.correlationId, variantId: event.variantId, sku: event.sku },
      'Consuming catalog.variant.created',
    );

    await this.autoInitStockLevel.execute(event);
  }
}
