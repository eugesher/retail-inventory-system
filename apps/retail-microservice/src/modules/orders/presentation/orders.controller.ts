import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  FulfillmentView,
  IPage,
  IPlaceOrderPayload,
  IRetailFulfillmentCreatePayload,
  IRetailFulfillmentListPayload,
  IRetailFulfillmentShipPayload,
  IRetailOrderGetPayload,
  IRetailOrderListPayload,
  IRetailPaymentCapturePayload,
  OrderView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  CapturePaymentUseCase,
  CreateFulfillmentUseCase,
  GetOrderUseCase,
  ListFulfillmentsUseCase,
  ListMyOrdersUseCase,
  PlaceOrderUseCase,
  ShipFulfillmentUseCase,
} from '../application/use-cases';

// RPC surface for the order operations (API Gateway → Retail over `retail_queue`).
// `retail.cart.place` is a cart-shaped key (it acts on a cart) served here in the
// orders controller, because the operation produces an immutable `Order` (ADR-028
// §1). `retail.order.get` / `retail.order.list` / `retail.payment.capture` are the
// read + capture keys (ADR-028 §3/§7). `retail.fulfillment.create` /
// `retail.fulfillment.list` are the fulfillment keys — a fulfillment is a sibling
// aggregate in the orders module (ADR-031), so its RPCs are served here too. Each
// handler is a thin delegate; an `OrderDomainException` is terminated by the
// `OrdersRpcExceptionFilter` into the `{ statusCode, ... }` wire shape the gateway maps.
@Controller()
export class OrdersController {
  constructor(
    private readonly placeOrder: PlaceOrderUseCase,
    private readonly getOrder: GetOrderUseCase,
    private readonly listMyOrders: ListMyOrdersUseCase,
    private readonly capturePayment: CapturePaymentUseCase,
    private readonly createFulfillment: CreateFulfillmentUseCase,
    private readonly listFulfillments: ListFulfillmentsUseCase,
    private readonly shipFulfillment: ShipFulfillmentUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_PLACE)
  public handlePlace(@Payload() payload: IPlaceOrderPayload): Promise<OrderView> {
    return this.placeOrder.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_GET)
  public handleGet(@Payload() payload: IRetailOrderGetPayload): Promise<OrderView> {
    return this.getOrder.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_ORDER_LIST)
  public handleList(@Payload() payload: IRetailOrderListPayload): Promise<IPage<OrderView>> {
    return this.listMyOrders.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_PAYMENT_CAPTURE)
  public handleCapture(@Payload() payload: IRetailPaymentCapturePayload): Promise<OrderView> {
    return this.capturePayment.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_FULFILLMENT_CREATE)
  public handleCreateFulfillment(
    @Payload() payload: IRetailFulfillmentCreatePayload,
  ): Promise<FulfillmentView> {
    return this.createFulfillment.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_FULFILLMENT_LIST)
  public handleListFulfillments(
    @Payload() payload: IRetailFulfillmentListPayload,
  ): Promise<FulfillmentView[]> {
    return this.listFulfillments.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_FULFILLMENT_SHIP)
  public handleShipFulfillment(
    @Payload() payload: IRetailFulfillmentShipPayload,
  ): Promise<FulfillmentView> {
    return this.shipFulfillment.execute(payload);
  }
}
