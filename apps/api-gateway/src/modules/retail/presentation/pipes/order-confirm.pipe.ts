import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PipeTransform,
} from '@nestjs/common';

import { OrderStatusEnum } from '@retail-inventory-system/contracts';

import { IRetailGatewayPort, RETAIL_GATEWAY_PORT } from '../../application/ports';

@Injectable()
export class OrderConfirmPipe implements PipeTransform<string, Promise<number>> {
  constructor(
    @Inject(RETAIL_GATEWAY_PORT)
    private readonly retailGateway: IRetailGatewayPort,
  ) {}

  public async transform(param: string): Promise<number> {
    const id = Number(param);

    if (isNaN(id)) {
      throw new BadRequestException('Validation failed (numeric string is expected)');
    }

    const order = await this.retailGateway.getOrderStatus(id);

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
