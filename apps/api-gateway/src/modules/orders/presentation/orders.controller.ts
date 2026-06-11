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
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { CurrentUser } from '@retail-inventory-system/auth';
import { ICurrentUser, IPage, OrderView } from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  CapturePaymentUseCase,
  GetOrderUseCase,
  ListMyOrdersUseCase,
} from '../application/use-cases';
import { CapturePaymentRequestDto, ListOrdersQueryDto } from './dto';

// HTTP surface over the retail microservice's order read + capture RPCs (ADR-009).
// Every route is bearer-protected by default (the global `JwtAuthGuard`); a customer-
// or guest-tier token passes the guard, and with **no `@RequiresPermission`** the
// permission guard allows it (a `@RequiresPermission('order:read'|'order:capture')`
// here would block the owning customer, who carries no permissions — ADR-024). The
// authorization model is **owner-or-staff-override**: the owner-check
// (`order.customerId === @CurrentUser().id`) lives in the retail use case, and the
// staff override (`order:read` / `order:capture`) is computed in the gateway use case
// from `@CurrentUser().permissions` and forwarded as a boolean (ADR-028 §7). A
// non-owner non-staff caller gets a 403; an unauthenticated caller a 401.
//
// `orderId` is the BIGINT `order.id` (a numeric param via `ParseIntPipe`).
@ApiTags('Order')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly getOrderUseCase: GetOrderUseCase,
    private readonly listMyOrdersUseCase: ListMyOrdersUseCase,
    private readonly capturePaymentUseCase: CapturePaymentUseCase,
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
}
