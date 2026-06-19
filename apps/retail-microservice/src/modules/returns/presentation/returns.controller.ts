import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IRetailReturnAuthorizePayload,
  IRetailReturnClosePayload,
  IRetailReturnGetPayload,
  IRetailReturnListPayload,
  IRetailReturnOpenPayload,
  IRetailReturnReceivePayload,
  IRetailReturnRejectPayload,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AuthorizeReturnUseCase,
  CloseReturnUseCase,
  GetReturnUseCase,
  ListReturnsForOrderUseCase,
  OpenReturnRequestUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from '../application/use-cases';

// RPC surface for the return (RMA) operations (API Gateway → Retail over `retail_queue`).
// The returns bounded context is its own module (ADR-032), so its seven `@MessagePattern`
// handlers live on their own controller (the one-aggregate-shaped controller convention).
// Each handler is a thin delegate; a `ReturnDomainException` is terminated by the
// `ReturnRpcExceptionFilter` into the `{ statusCode, message, code }` wire shape the
// gateway maps. The correlation id rides each payload and is logged inline by the use
// cases (ADR-011 — `PinoLogger.assign` would throw outside request scope).
//
// `retail.return.open` is owner-or-staff; `retail.return.authorize` / `.reject` /
// `.close` are staff `order:return-authorize`; `retail.return.receive` is warehouse
// `inventory:receive-return`; `retail.return.get` / `.list` are owner-or-staff
// `order:read` (all gated at the gateway — the use cases trust the resolved flag).
@Controller()
export class ReturnsController {
  constructor(
    private readonly openReturnRequest: OpenReturnRequestUseCase,
    private readonly authorizeReturn: AuthorizeReturnUseCase,
    private readonly rejectReturn: RejectReturnUseCase,
    private readonly receiveReturn: ReceiveReturnUseCase,
    private readonly closeReturn: CloseReturnUseCase,
    private readonly getReturn: GetReturnUseCase,
    private readonly listReturns: ListReturnsForOrderUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_OPEN)
  public handleOpen(@Payload() payload: IRetailReturnOpenPayload): Promise<ReturnRequestView> {
    return this.openReturnRequest.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_AUTHORIZE)
  public handleAuthorize(
    @Payload() payload: IRetailReturnAuthorizePayload,
  ): Promise<ReturnRequestView> {
    return this.authorizeReturn.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_REJECT)
  public handleReject(@Payload() payload: IRetailReturnRejectPayload): Promise<ReturnRequestView> {
    return this.rejectReturn.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_RECEIVE)
  public handleReceive(
    @Payload() payload: IRetailReturnReceivePayload,
  ): Promise<ReturnRequestView> {
    return this.receiveReturn.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_CLOSE)
  public handleClose(@Payload() payload: IRetailReturnClosePayload): Promise<ReturnRequestView> {
    return this.closeReturn.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_GET)
  public handleGet(@Payload() payload: IRetailReturnGetPayload): Promise<ReturnRequestView> {
    return this.getReturn.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_LIST)
  public handleList(@Payload() payload: IRetailReturnListPayload): Promise<ReturnRequestView[]> {
    return this.listReturns.execute(payload);
  }
}
