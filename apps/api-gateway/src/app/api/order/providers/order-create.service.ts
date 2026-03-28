import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import {
  IOrderCreatePayload,
  OrderCreateDto,
  OrderResponseDto,
} from '@retail-inventory-system/retail';
import { throwRpcError } from '../../../common/rpc-error.util';

@Injectable()
export class OrderCreateService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  public async execute(dto: OrderCreateDto, correlationId: string): Promise<OrderResponseDto> {
    try {
      return await firstValueFrom(
        this.retailMicroserviceClient.send<OrderResponseDto, IOrderCreatePayload>(
          MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE,
          { ...dto, correlationId },
        ),
      );
    } catch (error) {
      throwRpcError(error);
    }
  }
}
