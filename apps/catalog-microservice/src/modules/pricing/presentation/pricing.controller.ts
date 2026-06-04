import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { IPriceQuery, IPriceSetPayload, PriceView } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  ListPricesUseCase,
  SelectApplicablePriceUseCase,
  SetPriceUseCase,
} from '../application/use-cases';

// Thin RMQ entry points for the three pricing RPCs on `catalog_queue`. The
// handlers translate the wire payload into the use-case call; `correlationId` is
// logged inline inside each use case (`PinoLogger.assign()` throws outside
// request scope — ADR-001 / ADR-011), so the controller carries no logging of its
// own. Set and Schedule share `catalog.price.set` — they are one write with two
// outcomes, distinguished by `validFrom`, not two endpoints.
@Controller()
export class PricingController {
  constructor(
    private readonly setPriceUseCase: SetPriceUseCase,
    private readonly listPricesUseCase: ListPricesUseCase,
    private readonly selectApplicablePriceUseCase: SelectApplicablePriceUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.CATALOG_PRICE_SET)
  public setPrice(@Payload() payload: IPriceSetPayload): Promise<PriceView> {
    return this.setPriceUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_PRICE_LIST)
  public listPrices(@Payload() query: IPriceQuery): Promise<PriceView[]> {
    return this.listPricesUseCase.execute(query);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_PRICE_SELECT)
  public selectApplicablePrice(@Payload() query: IPriceQuery): Promise<PriceView | null> {
    return this.selectApplicablePriceUseCase.execute(query);
  }
}
