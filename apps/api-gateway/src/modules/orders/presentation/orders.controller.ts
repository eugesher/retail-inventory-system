import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { CurrentUser, RequiresPermission } from '@retail-inventory-system/auth';
import {
  FulfillmentView,
  ICurrentUser,
  IPage,
  OrderView,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  CancelLineUseCase,
  CancelOrderUseCase,
  CapturePaymentUseCase,
  CreateFulfillmentUseCase,
  GetOrderUseCase,
  ListFulfillmentsUseCase,
  ListMyOrdersUseCase,
  MarkDeliveredUseCase,
  ShipFulfillmentUseCase,
} from '../application/use-cases';
import {
  CancelLineRequestDto,
  CancelOrderRequestDto,
  CapturePaymentRequestDto,
  CreateFulfillmentRequestDto,
  ListOrdersQueryDto,
  ShipFulfillmentRequestDto,
} from './dto';

// HTTP surface over the retail microservice's order read + capture + fulfillment +
// cancel RPCs (ADR-009, ADR-031). Every route is bearer-protected by default (the
// global `JwtAuthGuard`). Two authorization shapes coexist (ADR-024 / ADR-028 §7):
//
//   - **Owner-or-staff** (Read, List orders, Capture, List fulfillments, Cancel Order)
//     carry **no `@RequiresPermission`** — that would block the owning customer, who
//     carries no permissions. The owner-check (`order.customerId === @CurrentUser().id`)
//     lives in the retail use case; the staff override (`order:read` / `order:capture` /
//     `order:cancel`) is computed in the gateway use case from `@CurrentUser().permissions`
//     and forwarded as a boolean. A customer reaches only its own order; staff with the
//     override reach any.
//   - **Staff-only** (Create / Ship / Deliver fulfillment, Cancel Line) ARE gated with
//     `@RequiresPermission('order:fulfill'|'order:cancel')`: a customer cannot fulfill
//     a shipment or cancel an individual line, so the permission gate is the right (and
//     simpler) shape. The gateway use case still resolves the staff flag from the same
//     `@CurrentUser().permissions` — always true for a caller that passes the gate — so
//     the retail use case stays the single enforcement point.
//
// A non-owner non-staff caller gets a 403; an unauthenticated caller a 401. Typed
// upstream codes (`FULFILLMENT_*` / `ORDER_*`) surface as 400/404/409 via `throwRpcError`.
//
// `orderId` / `fulfillmentId` / `lineId` are BIGINT ids (numeric params via `ParseIntPipe`).
@ApiTags('Order')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly getOrderUseCase: GetOrderUseCase,
    private readonly listMyOrdersUseCase: ListMyOrdersUseCase,
    private readonly capturePaymentUseCase: CapturePaymentUseCase,
    private readonly createFulfillmentUseCase: CreateFulfillmentUseCase,
    private readonly shipFulfillmentUseCase: ShipFulfillmentUseCase,
    private readonly markDeliveredUseCase: MarkDeliveredUseCase,
    private readonly listFulfillmentsUseCase: ListFulfillmentsUseCase,
    private readonly cancelOrderUseCase: CancelOrderUseCase,
    private readonly cancelLineUseCase: CancelLineUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List own orders for the authenticated caller (paginated, newest-first)',
  })
  @ApiExtraModels(OrderView)
  @ApiOkResponse({
    description: 'Own orders for the caller, paginated',
    // The handler returns the `IPage` envelope ({ items, total, page, size }), not a
    // bare array — describe the real shape so generated clients read `body.items`.
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: getSchemaPath(OrderView) } },
        total: { type: 'integer', example: 2 },
        page: { type: 'integer', example: 1 },
        size: { type: 'integer', example: 20 },
      },
    },
  })
  @ApiProduces('application/json')
  public async listMyOrders(
    @Query() query: ListOrdersQueryDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<OrderView>> {
    return this.listMyOrdersUseCase.execute(user, query, correlationId);
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Read an order by id (owner, or staff with order:read)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The order (with its lines + payment)', type: OrderView })
  @ApiProduces('application/json')
  public async getOrder(
    @Param('orderId', ParseIntPipe) orderId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<OrderView> {
    return this.getOrderUseCase.execute(orderId, user, correlationId);
  }

  @Post(':orderId/payments/capture')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Capture the order authorized payment (owner, or staff with order:capture)',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Accepted + logged but not deduped (re-capture is idempotent by payment state)',
  })
  @ApiOkResponse({ description: 'The order with the captured payment', type: OrderView })
  @ApiProduces('application/json')
  public async capturePayment(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CapturePaymentRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<OrderView> {
    return this.capturePaymentUseCase.execute(
      orderId,
      user,
      { amountMinor: dto.amountMinor, idempotencyKey },
      correlationId,
    );
  }

  @Post(':orderId/fulfillments')
  @RequiresPermission(PermissionCodeEnum.ORDER_FULFILL)
  @ApiOperation({
    summary: 'Create a fulfillment (shipment plan) for an order (staff order:fulfill)',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiCreatedResponse({ description: 'The created (pending) fulfillment', type: FulfillmentView })
  @ApiProduces('application/json')
  public async createFulfillment(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CreateFulfillmentRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<FulfillmentView> {
    return this.createFulfillmentUseCase.execute(
      orderId,
      user,
      { stockLocationId: dto.stockLocationId, lines: dto.lines },
      correlationId,
    );
  }

  @Get(':orderId/fulfillments')
  @ApiOperation({ summary: 'List an order fulfillments (owner, or staff with order:read)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiExtraModels(FulfillmentView)
  @ApiOkResponse({
    description: 'The order fulfillments, newest-first',
    schema: { type: 'array', items: { $ref: getSchemaPath(FulfillmentView) } },
  })
  @ApiProduces('application/json')
  public async listFulfillments(
    @Param('orderId', ParseIntPipe) orderId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<FulfillmentView[]> {
    return this.listFulfillmentsUseCase.execute(orderId, user, correlationId);
  }

  @Post(':orderId/fulfillments/:fulfillmentId/ship')
  @RequiresPermission(PermissionCodeEnum.ORDER_FULFILL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ship a pending fulfillment (staff order:fulfill; captures the payment inline)',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiParam({ name: 'fulfillmentId', type: Number, example: 1 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Accepted + logged but not deduped (a non-pending re-ship is a 409)',
  })
  @ApiOkResponse({ description: 'The shipped fulfillment', type: FulfillmentView })
  @ApiProduces('application/json')
  public async shipFulfillment(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('fulfillmentId', ParseIntPipe) fulfillmentId: number,
    @Body() dto: ShipFulfillmentRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<FulfillmentView> {
    return this.shipFulfillmentUseCase.execute(
      orderId,
      fulfillmentId,
      user,
      { trackingNumber: dto.trackingNumber, carrier: dto.carrier, idempotencyKey },
      correlationId,
    );
  }

  @Post(':orderId/fulfillments/:fulfillmentId/deliver')
  @RequiresPermission(PermissionCodeEnum.ORDER_FULFILL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a shipped fulfillment delivered (staff order:fulfill)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiParam({ name: 'fulfillmentId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The delivered fulfillment', type: FulfillmentView })
  @ApiProduces('application/json')
  public async markDelivered(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('fulfillmentId', ParseIntPipe) fulfillmentId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<FulfillmentView> {
    return this.markDeliveredUseCase.execute(orderId, fulfillmentId, user, correlationId);
  }

  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a not-yet-shipped order (owner, or staff with order:cancel)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The cancelled order', type: OrderView })
  @ApiProduces('application/json')
  public async cancelOrder(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CancelOrderRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<OrderView> {
    return this.cancelOrderUseCase.execute(orderId, user, { reason: dto.reason }, correlationId);
  }

  @Post(':orderId/lines/:lineId/cancel')
  @RequiresPermission(PermissionCodeEnum.ORDER_CANCEL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an order line unshipped quantity (staff order:cancel)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiParam({ name: 'lineId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The updated order', type: OrderView })
  @ApiProduces('application/json')
  public async cancelLine(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() dto: CancelLineRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<OrderView> {
    return this.cancelLineUseCase.execute(
      orderId,
      lineId,
      user,
      { quantity: dto.quantity },
      correlationId,
    );
  }
}
