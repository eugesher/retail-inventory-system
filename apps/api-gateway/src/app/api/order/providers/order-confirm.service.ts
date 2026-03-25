import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { OrderConfirmResponseDto } from '@retail-inventory-system/retail';
import { throwRpcError } from '../../../common/rpc-error.util';

@Injectable()
export class OrderConfirmService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  public async execute(id: number): Promise<OrderConfirmResponseDto> {
    try {
      return await firstValueFrom(
        this.retailMicroserviceClient.send<OrderConfirmResponseDto, number>(
          MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM,
          id,
        ),
      );
    } catch (error) {
      throwRpcError(error);
    }
  }
}
