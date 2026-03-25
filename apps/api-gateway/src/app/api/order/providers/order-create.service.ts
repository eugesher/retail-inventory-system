import {
  BadRequestException,
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
import { OrderCreateDto, OrderResponseDto } from '@retail-inventory-system/retail';

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
      const { statusCode, message } = error as Record<string, unknown>;
      const code = Number(statusCode);
      const msg = typeof message === 'string' ? message : undefined;

      if (code === (HttpStatus.NOT_FOUND as number)) throw new NotFoundException(msg);
      if (code === (HttpStatus.BAD_REQUEST as number)) throw new BadRequestException(msg);

      throw new InternalServerErrorException(msg);
    }
  }
}
