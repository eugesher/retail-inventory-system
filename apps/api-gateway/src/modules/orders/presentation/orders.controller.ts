import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
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
import { Response } from 'express';

import { CurrentUser, RequiresPermission } from '@retail-inventory-system/auth';
import {
  FulfillmentView,
  ICurrentUser,
  IPage,
  OrderView,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { IdempotencyKey } from '../../../common/decorators';
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
    required: true,
    description:
      'Required (ADR-036). Same key + same body replays the stored order (Idempotent-Replay: true); same key + different body → 422; a missing key → 400.',
  })
  @ApiOkResponse({ description: 'The order with the captured payment', type: OrderView })
  @ApiProduces('application/json')
  public async capturePayment(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: CapturePaymentRequestDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const result = await this.capturePaymentUseCase.execute(
      orderId,
      user,
      { amountMinor: dto.amountMinor, idempotencyKey },
      correlationId,
    );
    if (result.replayed) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    return result.view;
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
    required: true,
    description:
      'Required (ADR-036). Same key + same body replays the stored ship (Idempotent-Replay: true); same key + different body → 422; a missing key → 400.',
  })
  @ApiOkResponse({ description: 'The shipped fulfillment', type: FulfillmentView })
  @ApiProduces('application/json')
  public async shipFulfillment(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Param('fulfillmentId', ParseIntPipe) fulfillmentId: number,
    @Body() dto: ShipFulfillmentRequestDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FulfillmentView> {
    const result = await this.shipFulfillmentUseCase.execute(
      orderId,
      fulfillmentId,
      user,
      { trackingNumber: dto.trackingNumber, carrier: dto.carrier, idempotencyKey },
      correlationId,
    );
    if (result.replayed) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    return result.view;
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
