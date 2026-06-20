import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

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
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAuthorizeReturnCommand,
  ICloseReturnCommand,
  IGetReturnQuery,
  IInspectReturnCommand,
  IListOrderReturnsQuery,
  IOpenReturnCommand,
  IReceiveReturnCommand,
  IRejectReturnCommand,
  IReturnsGatewayPort,
} from '../../application/ports';

// The single `ClientProxy` holder for the gateway returns module (ADR-009 / ADR-020).
// Each method materializes the RPC with `firstValueFrom` and stitches the
// transport-level `correlationId` onto the wire payload; everything else in the module
// depends on `IReturnsGatewayPort`, never on `@nestjs/microservices`. All eight RPCs
// target `retail_queue` via the `RETAIL_MICROSERVICE` client (the returns controller
// serves them — the returns bounded context is its own retail module, ADR-032). A
// rejected RPC flows back as the returns filter's `{ statusCode, message, code }`, which
// the calling use case re-throws through `throwRpcError` (typed `RETURN_*` code preserved
// so a client can branch on it).
@Injectable()
export class ReturnsRabbitmqAdapter implements IReturnsGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async openReturn(
    command: IOpenReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnOpenPayload>(
        ROUTING_KEYS.RETAIL_RETURN_OPEN,
        {
          ...command,
          correlationId,
        },
      ),
    );
  }

  public async authorizeReturn(
    command: IAuthorizeReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnAuthorizePayload>(
        ROUTING_KEYS.RETAIL_RETURN_AUTHORIZE,
        { ...command, correlationId },
      ),
    );
  }

  public async rejectReturn(
    command: IRejectReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnRejectPayload>(
        ROUTING_KEYS.RETAIL_RETURN_REJECT,
        { ...command, correlationId },
      ),
    );
  }

  public async receiveReturn(
    command: IReceiveReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnReceivePayload>(
        ROUTING_KEYS.RETAIL_RETURN_RECEIVE,
        { ...command, correlationId },
      ),
    );
  }

  public async inspectReturn(
    command: IInspectReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnInspectPayload>(
        ROUTING_KEYS.RETAIL_RETURN_INSPECT,
        { ...command, correlationId },
      ),
    );
  }

  public async closeReturn(
    command: ICloseReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnClosePayload>(
        ROUTING_KEYS.RETAIL_RETURN_CLOSE,
        { ...command, correlationId },
      ),
    );
  }

  public async getReturn(
    query: IGetReturnQuery,
    correlationId: string,
  ): Promise<ReturnRequestView> {
    return firstValueFrom(
      this.client.send<ReturnRequestView, IRetailReturnGetPayload>(ROUTING_KEYS.RETAIL_RETURN_GET, {
        ...query,
        correlationId,
      }),
    );
  }

  public async listOrderReturns(
    query: IListOrderReturnsQuery,
    correlationId: string,
  ): Promise<ReturnRequestView[]> {
    return firstValueFrom(
      this.client.send<ReturnRequestView[], IRetailReturnListPayload>(
        ROUTING_KEYS.RETAIL_RETURN_LIST,
        { ...query, correlationId },
      ),
    );
  }
}
