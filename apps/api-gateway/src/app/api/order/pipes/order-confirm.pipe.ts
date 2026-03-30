import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PipeTransform,
} from '@nestjs/common';
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

  public async transform(param: string): Promise<number> {
    const id = Number(param);

    if (isNaN(id)) {
      throw new BadRequestException('Validation failed (numeric string is expected)');
    }

    const order = await firstValueFrom(
      this.retailMicroserviceClient.send<{ statusId: OrderStatusEnum } | null, number>(
        MicroserviceMessagePatternEnum.RETAIL_ORDER_GET,
        id,
      ),
    );

    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    if (order.statusId !== OrderStatusEnum.PENDING) {
      throw new BadRequestException(
        `Order #${id} cannot be confirmed: expected status "${OrderStatusEnum.PENDING}", got "${order.statusId}"`,
      );
    }

    return id;
  }
}
