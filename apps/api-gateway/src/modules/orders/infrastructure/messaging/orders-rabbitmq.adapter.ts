import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  FulfillmentView,
  IPage,
  IRetailFulfillmentCreatePayload,
  IRetailFulfillmentDeliverPayload,
  IRetailFulfillmentListPayload,
  IRetailFulfillmentShipPayload,
  IRetailOrderCancelLinePayload,
  IRetailOrderCancelPayload,
  IRetailOrderGetPayload,
  IRetailOrderListPayload,
  IRetailPaymentCapturePayload,
  OrderView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IFulfillmentCreateCommand,
  IFulfillmentDeliverCommand,
  IFulfillmentListQuery,
  IFulfillmentShipCommand,
  IOrderCancelCommand,
  IOrderGetQuery,
  IOrderLineCancelCommand,
  IOrderListQuery,
  IOrdersGatewayPort,
  IPaymentCaptureCommand,
} from '../../application/ports';

// The single `ClientProxy` holder for the gateway orders module (ADR-009 /
// ADR-020). Each method materializes the RPC with `firstValueFrom` and stitches the
// transport-level `correlationId` onto the wire payload; everything else in the
// module depends on `IOrdersGatewayPort`, never on `@nestjs/microservices`. All the
// RPCs target `retail_queue` via the `RETAIL_MICROSERVICE` client (the orders
// controller serves them, since they act on `Order` / its `Fulfillment` siblings). A
// rejected RPC flows back as the retail filter's `{ statusCode, message, code, details }`,
// which the calling use case re-throws through `throwRpcError` (typed `code` + `details`
// preserved).
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

  public async createFulfillment(
    command: IFulfillmentCreateCommand,
    correlationId: string,
  ): Promise<FulfillmentView> {
    return firstValueFrom(
      this.client.send<FulfillmentView, IRetailFulfillmentCreatePayload>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_CREATE,
        { ...command, correlationId },
      ),
    );
  }

  public async shipFulfillment(
    command: IFulfillmentShipCommand,
    correlationId: string,
  ): Promise<FulfillmentView> {
    return firstValueFrom(
      this.client.send<FulfillmentView, IRetailFulfillmentShipPayload>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_SHIP,
        { ...command, correlationId },
      ),
    );
  }

  public async markDelivered(
    command: IFulfillmentDeliverCommand,
    correlationId: string,
  ): Promise<FulfillmentView> {
    return firstValueFrom(
      this.client.send<FulfillmentView, IRetailFulfillmentDeliverPayload>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVER,
        { ...command, correlationId },
      ),
    );
  }

  public async listFulfillments(
    query: IFulfillmentListQuery,
    correlationId: string,
  ): Promise<FulfillmentView[]> {
    return firstValueFrom(
      this.client.send<FulfillmentView[], IRetailFulfillmentListPayload>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_LIST,
        { ...query, correlationId },
      ),
    );
  }

  public async cancelOrder(
    command: IOrderCancelCommand,
    correlationId: string,
  ): Promise<OrderView> {
    return firstValueFrom(
      this.client.send<OrderView, IRetailOrderCancelPayload>(ROUTING_KEYS.RETAIL_ORDER_CANCEL, {
        ...command,
        correlationId,
      }),
    );
  }

  public async cancelLine(
    command: IOrderLineCancelCommand,
    correlationId: string,
  ): Promise<OrderView> {
    return firstValueFrom(
      this.client.send<OrderView, IRetailOrderCancelLinePayload>(
        ROUTING_KEYS.RETAIL_ORDER_CANCEL_LINE,
        { ...command, correlationId },
      ),
    );
  }
}
