import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { OrderCreateDto, OrderResponseDto } from '@retail-inventory-system/retail';
import { throwRpcError } from '../../../common/rpc-error.util';

@Injectable()
export class OrderCreateService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  public async execute(dto: OrderCreateDto): Promise<OrderResponseDto> {
    try {
      return await firstValueFrom(
        this.retailMicroserviceClient.send<OrderResponseDto, OrderCreateDto>(
          MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE,
          dto,
        ),
      );
    } catch (error) {
      throwRpcError(error);
    }
  }
}
