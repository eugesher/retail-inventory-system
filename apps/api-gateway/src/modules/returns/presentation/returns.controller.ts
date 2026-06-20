import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { CurrentUser, RequiresPermission } from '@retail-inventory-system/auth';
import {
  ICurrentUser,
  PermissionCodeEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AuthorizeReturnUseCase,
  CloseReturnUseCase,
  GetReturnUseCase,
  InspectReturnUseCase,
  ListOrderReturnsUseCase,
  OpenReturnUseCase,
  ReceiveReturnUseCase,
  RejectReturnUseCase,
} from '../application/use-cases';
import { InspectReturnRequestDto, OpenReturnRequestDto, RejectReturnRequestDto } from './dto';

// HTTP surface over the retail microservice's eight return-lifecycle (RMA) RPCs
// (ADR-009, ADR-032). The controller has **no path prefix** — it serves both the
// order-scoped Open + List (`/api/orders/:orderId/returns`) and the RMA-scoped lifecycle
// routes (`/api/returns/:rmaId/*`) — so it sits alongside the orders controller without a
// route clash (Nest resolves by full path). Every route is bearer-protected by default
// (the global `JwtAuthGuard`). Two authorization shapes coexist (ADR-024 / ADR-028 §7):
//
//   - **Owner-or-staff** (Open, Get RMA, List RMAs) carry **no `@RequiresPermission`** —
//     that would block the owning customer, who carries no permissions. The owner-check
//     (`order.customerId === @CurrentUser().id`) lives in the retail use case; the staff
//     override (`order:return-authorize` for Open, `order:read` for the reads) is computed
//     in the gateway use case from `@CurrentUser().permissions` and forwarded as a boolean.
//   - **Staff-only** (Authorize, Reject, Close — `order:return-authorize`; Receive,
//     Inspect — `inventory:receive-return`) ARE gated with `@RequiresPermission`: a customer
//     cannot authorize a return, receive goods, or record an inspection. The use case still
//     folds `@CurrentUser().id` into `actorId` for the audit/restock attribution.
//
// A non-owner non-staff caller gets a 403; an unauthenticated caller a 401. Typed upstream
// codes (`RETURN_*`) surface as 400/403/404/409 via `throwRpcError`. `orderId` / `rmaId`
// are BIGINT ids (numeric params via `ParseIntPipe`).
@ApiTags('Return')
@ApiBearerAuth()
@Controller()
export class ReturnsController {
  constructor(
    private readonly openReturnUseCase: OpenReturnUseCase,
    private readonly authorizeReturnUseCase: AuthorizeReturnUseCase,
    private readonly rejectReturnUseCase: RejectReturnUseCase,
    private readonly receiveReturnUseCase: ReceiveReturnUseCase,
    private readonly inspectReturnUseCase: InspectReturnUseCase,
    private readonly closeReturnUseCase: CloseReturnUseCase,
    private readonly getReturnUseCase: GetReturnUseCase,
    private readonly listOrderReturnsUseCase: ListOrderReturnsUseCase,
  ) {}

  @Post('orders/:orderId/returns')
  @ApiOperation({
    summary: 'Open a return request (RMA) for an order (owner, or staff order:return-authorize)',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiCreatedResponse({
    description: 'The opened (requested) return request',
    type: ReturnRequestView,
  })
  @ApiProduces('application/json')
  public async openReturn(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: OpenReturnRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.openReturnUseCase.execute(
      orderId,
      user,
      { reasonCategory: dto.reasonCategory, notes: dto.notes, lines: dto.lines },
      correlationId,
    );
  }

  @Get('orders/:orderId/returns')
  @ApiOperation({ summary: 'List an order return requests (owner, or staff with order:read)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiExtraModels(ReturnRequestView)
  @ApiOkResponse({
    description: 'The order return requests, newest-first',
    schema: { type: 'array', items: { $ref: getSchemaPath(ReturnRequestView) } },
  })
  @ApiProduces('application/json')
  public async listOrderReturns(
    @Param('orderId', ParseIntPipe) orderId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView[]> {
    return this.listOrderReturnsUseCase.execute(orderId, user, correlationId);
  }

  @Post('returns/:rmaId/authorize')
  @RequiresPermission(PermissionCodeEnum.ORDER_RETURN_AUTHORIZE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authorize a requested return (staff order:return-authorize)' })
  @ApiParam({ name: 'rmaId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The authorized return request', type: ReturnRequestView })
  @ApiProduces('application/json')
  public async authorizeReturn(
    @Param('rmaId', ParseIntPipe) rmaId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.authorizeReturnUseCase.execute(rmaId, user, correlationId);
  }

  @Post('returns/:rmaId/reject')
  @RequiresPermission(PermissionCodeEnum.ORDER_RETURN_AUTHORIZE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a requested return (staff order:return-authorize)' })
  @ApiParam({ name: 'rmaId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The rejected return request', type: ReturnRequestView })
  @ApiProduces('application/json')
  public async rejectReturn(
    @Param('rmaId', ParseIntPipe) rmaId: number,
    @Body() dto: RejectReturnRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.rejectReturnUseCase.execute(rmaId, user, { reason: dto.reason }, correlationId);
  }

  @Post('returns/:rmaId/receive')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_RECEIVE_RETURN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive an authorized return into the warehouse (staff inventory:receive-return)',
  })
  @ApiParam({ name: 'rmaId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The received return request', type: ReturnRequestView })
  @ApiProduces('application/json')
  public async receiveReturn(
    @Param('rmaId', ParseIntPipe) rmaId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.receiveReturnUseCase.execute(rmaId, user, correlationId);
  }

  @Post('returns/:rmaId/inspect')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_RECEIVE_RETURN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Inspect a received return + record per-line disposition (staff inventory:receive-return)',
  })
  @ApiParam({ name: 'rmaId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The inspected return request', type: ReturnRequestView })
  @ApiProduces('application/json')
  public async inspectReturn(
    @Param('rmaId', ParseIntPipe) rmaId: number,
    @Body() dto: InspectReturnRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.inspectReturnUseCase.execute(rmaId, user, { lines: dto.lines }, correlationId);
  }

  @Post('returns/:rmaId/close')
  @RequiresPermission(PermissionCodeEnum.ORDER_RETURN_AUTHORIZE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an inspected return (staff order:return-authorize)' })
  @ApiParam({ name: 'rmaId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The closed return request', type: ReturnRequestView })
  @ApiProduces('application/json')
  public async closeReturn(
    @Param('rmaId', ParseIntPipe) rmaId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.closeReturnUseCase.execute(rmaId, user, correlationId);
  }

  @Get('returns/:rmaId')
  @ApiOperation({ summary: 'Read a return request by id (owner, or staff with order:read)' })
  @ApiParam({ name: 'rmaId', type: Number, example: 1 })
  @ApiOkResponse({ description: 'The return request (with its lines)', type: ReturnRequestView })
  @ApiProduces('application/json')
  public async getReturn(
    @Param('rmaId', ParseIntPipe) rmaId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<ReturnRequestView> {
    return this.getReturnUseCase.execute(rmaId, user, correlationId);
  }
}
