import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { OrderResponseDto } from '@retail-inventory-system/retail';

@Injectable()
export class OrderConfirmService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  public async execute(id: number): Promise<OrderResponseDto> {
    return await firstValueFrom(
      this.retailMicroserviceClient.send<OrderResponseDto, number>(
        MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM,
        id,
      ),
    );
  }
}
