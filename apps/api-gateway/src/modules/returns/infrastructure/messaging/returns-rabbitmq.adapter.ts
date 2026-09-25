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
