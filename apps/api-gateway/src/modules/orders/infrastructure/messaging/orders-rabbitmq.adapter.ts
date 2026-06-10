import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IPage,
  IRetailOrderGetPayload,
  IRetailOrderListPayload,
  IRetailPaymentCapturePayload,
  OrderView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IOrderGetQuery,
  IOrderListQuery,
  IOrdersGatewayPort,
  IPaymentCaptureCommand,
} from '../../application/ports';

// The single `ClientProxy` holder for the gateway orders module (ADR-009 /
// ADR-020). Each method materializes the RPC with `firstValueFrom` and stitches the
// transport-level `correlationId` onto the wire payload; everything else in the
// module depends on `IOrdersGatewayPort`, never on `@nestjs/microservices`. All
// three RPCs target `retail_queue` via the `RETAIL_MICROSERVICE` client (the orders
// controller serves them, since they act on `Order`).
@Injectable()
export class OrdersRabbitmqAdapter implements IOrdersGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async getOrder(query: IOrderGetQuery, correlationId: string): Promise<OrderView> {
    return firstValueFrom(
      this.client.send<OrderView, IRetailOrderGetPayload>(ROUTING_KEYS.RETAIL_ORDER_GET, {
        ...query,
        correlationId,
      }),
    );
  }

  public async listMyOrders(
    query: IOrderListQuery,
    correlationId: string,
  ): Promise<IPage<OrderView>> {
    return firstValueFrom(
      this.client.send<IPage<OrderView>, IRetailOrderListPayload>(ROUTING_KEYS.RETAIL_ORDER_LIST, {
        ...query,
        correlationId,
      }),
    );
  }

  public async capturePayment(
    command: IPaymentCaptureCommand,
    correlationId: string,
  ): Promise<OrderView> {
    return firstValueFrom(
      this.client.send<OrderView, IRetailPaymentCapturePayload>(
        ROUTING_KEYS.RETAIL_PAYMENT_CAPTURE,
        { ...command, correlationId },
      ),
    );
  }
}
