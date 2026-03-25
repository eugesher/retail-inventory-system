import {
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { OrderConfirmResponseDto } from '@retail-inventory-system/retail';

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
      const { statusCode, message } = error as Record<string, unknown>;
      const code = Number(statusCode);
      const msg = typeof message === 'string' ? message : undefined;

      if (code === (HttpStatus.NOT_FOUND as number)) throw new NotFoundException(msg);

      throw new InternalServerErrorException(msg);
    }
  }
}
