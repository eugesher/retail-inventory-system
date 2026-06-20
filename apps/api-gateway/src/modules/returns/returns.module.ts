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

// Gateway-side port→adapter module fronting the retail microservice's eight
// return-lifecycle (RMA) RPCs over HTTP at `/api/returns/*` + `/api/orders/:orderId/returns`
// (ADR-009, ADR-032). Named after the downstream returns bounded context (its own retail
// module). `ReturnsRabbitmqAdapter` (the sole `ClientProxy` holder) backs
// `RETURNS_GATEWAY_PORT`; the use cases and controller depend on the port symbol only. The
// gateway holds no return state of its own — `MicroserviceClientRetailModule` provides the
// `RETAIL_MICROSERVICE` client that targets `retail_queue` (the returns controller serves
// the RPCs there). There is no `domain/`: every route folds the verified `@CurrentUser()`
// identity into the command and the retail use case enforces the owner(-or-staff) check
// (ADR-028 §7).
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
