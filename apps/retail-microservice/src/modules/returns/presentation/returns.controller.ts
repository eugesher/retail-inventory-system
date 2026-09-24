import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IRetailReturnAuthorizePayload,
  IRetailReturnClosePayload,
  IRetailReturnGetPayload,
  IRetailReturnInspectPayload,
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
  InspectAndDispositionUseCase,
  ListReturnsForOrderUseCase,
  OpenReturnRequestUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from '../application/use-cases';

@Controller()
export class ReturnsController {
  constructor(
    private readonly openReturnRequest: OpenReturnRequestUseCase,
    private readonly authorizeReturn: AuthorizeReturnUseCase,
    private readonly rejectReturn: RejectReturnUseCase,
    private readonly receiveReturn: ReceiveReturnUseCase,
    private readonly inspectAndDisposition: InspectAndDispositionUseCase,
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

  @MessagePattern(ROUTING_KEYS.RETAIL_RETURN_INSPECT)
  public handleInspect(
    @Payload() payload: IRetailReturnInspectPayload,
  ): Promise<ReturnRequestView> {
    return this.inspectAndDisposition.execute(payload);
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
