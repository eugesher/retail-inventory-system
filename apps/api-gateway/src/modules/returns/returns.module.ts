import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/messaging';

import { RETURNS_GATEWAY_PORT } from './application/ports';
import {
  AuthorizeReturnUseCase,
  CloseReturnUseCase,
  GetReturnUseCase,
  InspectReturnUseCase,
  ListOrderReturnsUseCase,
  OpenReturnUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from './application/use-cases';
import { ReturnsRabbitmqAdapter } from './infrastructure/messaging';
import { ReturnsController } from './presentation';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [ReturnsController],
  providers: [
    OpenReturnUseCase,
    AuthorizeReturnUseCase,
    RejectReturnUseCase,
    ReceiveReturnUseCase,
    InspectReturnUseCase,
    CloseReturnUseCase,
    GetReturnUseCase,
    ListOrderReturnsUseCase,
    { provide: RETURNS_GATEWAY_PORT, useClass: ReturnsRabbitmqAdapter },
  ],
})
export class ReturnsModule {}
