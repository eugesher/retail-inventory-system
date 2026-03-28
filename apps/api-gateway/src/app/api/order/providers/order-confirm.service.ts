import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IOrderConfirmPayload, OrderConfirmResponseDto } from '@retail-inventory-system/retail';
import { throwRpcError } from '../../../common/rpc-error.util';

@Injectable()
export class OrderConfirmService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  public async execute(id: number, correlationId: string): Promise<OrderConfirmResponseDto> {
    try {
      return await firstValueFrom(
        this.retailMicroserviceClient.send<OrderConfirmResponseDto, IOrderConfirmPayload>(
          MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM,
          { id, correlationId },
        ),
      );
    } catch (error) {
      throwRpcError(error);
    }
  }
}
