import { BadRequestException, Inject, Injectable, PipeTransform } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { OrderStatusEnum } from '@retail-inventory-system/retail';

@Injectable()
export class OrderConfirmPipe implements PipeTransform<string, Promise<number>> {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailMicroserviceClient: ClientProxy,
  ) {}

  public async transform(value: string): Promise<number> {
    const id = Number(value);

    const order = await firstValueFrom(
      this.retailMicroserviceClient.send<{ statusId: OrderStatusEnum }, number>(
        MicroserviceMessagePatternEnum.RETAIL_ORDER_GET,
        id,
      ),
    );

    if (order.statusId !== OrderStatusEnum.PENDING) {
      throw new BadRequestException(
        `Order #${id} cannot be confirmed: expected status "${OrderStatusEnum.PENDING}", got "${order.statusId}"`,
      );
    }

    return id;
  }
}
