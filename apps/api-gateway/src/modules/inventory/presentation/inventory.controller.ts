import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { CurrentUser, Public, RequiresPermission } from '@retail-inventory-system/auth';
import {
  ICurrentUser,
  IPage,
  IReservationReleaseResult,
  IStockTransferResult,
  PermissionCodeEnum,
  ReservationView,
  StockLevelView,
  StockLocationView,
  StockMovementView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AdjustStockUseCase,
  GetVariantStockUseCase,
  ListLocationsUseCase,
  ListVariantMovementsUseCase,
  ReceiveStockUseCase,
  ReleaseReservationUseCase,
  TransferStockUseCase,
} from '../application/use-cases';
import {
  AdjustStockRequestDto,
  MovementsQueryDto,
  ReceiveStockRequestDto,
  TransferStockRequestDto,
  VariantStockQueryDto,
} from './dto';

// HTTP surface over the inventory microservice's read + write RPCs (ADR-009). The
// gateway holds no inventory state of its own — each method is a thin port→adapter
// pass to `inventory_queue`.
//
// The routes are gated by intent (ADR-024): the per-variant availability read is
// `@Public()`, because an unauthenticated shopper needs to see whether an item is
// in stock before checking out; the stock-location list and the per-variant
// movements audit read are operational data, so they require `inventory:read`; the
// receive/adjust/transfer writes require `inventory:adjust` / `inventory:transfer`;
// the manual reservation release is an operator action over the holds, so it reuses
// `inventory:adjust` (no new permission code was minted — the existing
// read/adjust codes cover the audit + ops surface, ADR-024). Every permission code
// is staff-only — customer tokens carry no `permissions` claim — so the location
// list, the audit read, the writes, and the manual release are staff-only by
// construction.
@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly getVariantStockUseCase: GetVariantStockUseCase,
    private readonly listLocationsUseCase: ListLocationsUseCase,
    private readonly receiveStockUseCase: ReceiveStockUseCase,
    private readonly adjustStockUseCase: AdjustStockUseCase,
    private readonly transferStockUseCase: TransferStockUseCase,
    private readonly listVariantMovementsUseCase: ListVariantMovementsUseCase,
    private readonly releaseReservationUseCase: ReleaseReservationUseCase,
  ) {}

  @Get('locations')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_READ)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the stock locations (staff, inventory:read)' })
  @ApiQuery({
    name: 'activeOnly',
    type: Boolean,
    required: false,
    description: 'Drop deactivated locations from the result',
  })
  @ApiOkResponse({ description: 'Stock locations', type: StockLocationView, isArray: true })
  @ApiProduces('application/json')
  public async listLocations(
    @Query('activeOnly', new ParseBoolPipe({ optional: true })) activeOnly: boolean | undefined,
    @CorrelationId() correlationId: string,
  ): Promise<StockLocationView[]> {
    return this.listLocationsUseCase.execute({ activeOnly }, correlationId);
  }

  @Get('variants/:variantId/stock')
  @Public()
  @ApiOperation({ summary: 'Read a variant’s availability across stock locations (public)' })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  // No stock-level rows for the variant is a valid answer — a `200` with
  // `totalOnHand: 0`, `totalAvailable: 0`, `locations: []` (not a 404). Omitting
  // `?locationIds` aggregates across every location.
  @ApiOkResponse({
    description: 'Per-location availability plus cross-location totals',
    type: VariantStockView,
  })
  @ApiProduces('application/json')
  public async getVariantStock(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Query() query: VariantStockQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<VariantStockView> {
    return this.getVariantStockUseCase.execute(
      { variantId, stockLocationIds: query.locationIds },
      correlationId,
    );
  }

  @Get('variants/:variantId/movements')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_READ)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List a variant’s stock-movement audit trail (staff, inventory:read)',
  })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  // A variant with no movements (or an unknown variant) is a `200` empty page —
  // the public-read zero-answer convention; there is no existence probe. The
  // timeline is newest-first (`occurredAt DESC`); `total` is the full match count.
  @ApiExtraModels(StockMovementView)
  @ApiOkResponse({
    description: 'A paginated, newest-first page of the variant’s stock-movement ledger rows',
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: getSchemaPath(StockMovementView) } },
        total: { type: 'number' },
        page: { type: 'number' },
        size: { type: 'number' },
      },
    },
  })
  @ApiProduces('application/json')
  public async listVariantMovements(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Query() query: MovementsQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<StockMovementView>> {
    // Defaults applied at the edge (`page`→1, `pageSize`→20); `pageSize` maps onto
    // the RPC payload's `size`. The DTO already enforced the `1..100` bounds.
    return this.listVariantMovementsUseCase.execute({
      variantId,
      page: query.page ?? 1,
      size: query.pageSize ?? 20,
      type: query.type,
      from: query.from,
      to: query.to,
      correlationId,
    });
  }

  @Post('variants/:variantId/stock/receive')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive stock — raise on-hand (staff, inventory:adjust)' })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  @ApiOkResponse({
    description: 'Updated stock level for the affected location',
    type: StockLevelView,
  })
  @ApiProduces('application/json')
  public async receiveStock(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: ReceiveStockRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<StockLevelView> {
    return this.receiveStockUseCase.execute(
      { ...dto, variantId, actorId: actor.id },
      correlationId,
    );
  }

  @Post('variants/:variantId/stock/adjust')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Adjust stock — signed delta with a reason (staff, inventory:adjust)' })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  // A signed adjustment that would drive on-hand below zero is a 409 (surfaced
  // from the inventory domain via its RPC exception filter).
  @ApiOkResponse({
    description: 'Updated stock level for the affected location',
    type: StockLevelView,
  })
  @ApiProduces('application/json')
  public async adjustStock(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: AdjustStockRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<StockLevelView> {
    return this.adjustStockUseCase.execute({ ...dto, variantId, actorId: actor.id }, correlationId);
  }

  @Post('variants/:variantId/stock/transfer')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_TRANSFER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer stock between two locations (staff, inventory:transfer)',
  })
  @ApiParam({ name: 'variantId', type: Number, example: 1 })
  // A transfer of more than the source's on-hand is a 409 (the domain below-zero
  // invariant); a bad quantity or identical source/destination is a 400.
  @ApiExtraModels(StockLevelView)
  @ApiOkResponse({
    description: 'Both post-transfer levels: from (debited source) and to (credited destination)',
    schema: {
      type: 'object',
      properties: {
        from: { $ref: getSchemaPath(StockLevelView) },
        to: { $ref: getSchemaPath(StockLevelView) },
      },
    },
  })
  @ApiProduces('application/json')
  public async transferStock(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: TransferStockRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<IStockTransferResult> {
    return this.transferStockUseCase.execute(
      { ...dto, variantId, actorId: actor.id },
      correlationId,
    );
  }

  @Post('reservations/:reservationId/release')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually release a reservation hold (staff, inventory:adjust)',
  })
  @ApiParam({
    name: 'reservationId',
    type: String,
    example: '3f1c9b6e-4d2a-4f8e-9c1b-2a7d6e5f0a11',
    description:
      'The reservation (hold) UUID — sourced from logs, the inventory.stock.reserved event, or the DB',
  })
  // Targets ONE hold by id: an unknown id is a 404 (`INVENTORY_RESERVATION_NOT_FOUND`),
  // an already-released/committed row a 409 (`INVENTORY_RESERVATION_INVALID_STATE`),
  // both surfaced from the inventory domain via its RPC exception filter. Frees the
  // hold, returns the units to `available`, and writes a `manual`-reason `release`
  // ledger row attributed to the staff actor. No request body.
  @ApiExtraModels(ReservationView)
  @ApiOkResponse({
    description: 'The released hold(s) — exactly one element for a by-id release',
    schema: {
      type: 'object',
      properties: {
        released: { type: 'array', items: { $ref: getSchemaPath(ReservationView) } },
      },
    },
  })
  @ApiProduces('application/json')
  public async releaseReservation(
    @Param('reservationId') reservationId: string,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<IReservationReleaseResult> {
    // The ops/manual release: a by-id selector, the fixed `manual` reason, and the
    // staff actor folded in for the ledger attribution (ADR-030 §4).
    return this.releaseReservationUseCase.execute({
      reservationId,
      reason: 'manual',
      actorId: actor.id,
      correlationId,
    });
  }
}
