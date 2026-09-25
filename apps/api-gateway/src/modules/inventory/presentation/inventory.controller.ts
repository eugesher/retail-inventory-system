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
  IReservationSweepResult,
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
  SweepReservationsUseCase,
  TransferStockUseCase,
} from '../application/use-cases';
import {
  AdjustStockRequestDto,
  MovementsQueryDto,
  ReceiveStockRequestDto,
  SweepReservationsRequestDto,
  TransferStockRequestDto,
  VariantStockQueryDto,
} from './dto';

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
    private readonly sweepReservationsUseCase: SweepReservationsUseCase,
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

  @Post('reservations/sweep')
  @RequiresPermission(PermissionCodeEnum.INVENTORY_ADJUST)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sweep expired reservation holds on demand (staff, inventory:adjust)',
  })
  @ApiOkResponse({
    description:
      'Sweep counters. `scanned = expired + skipped` always holds: a skipped candidate is one a concurrent writer had already settled or refreshed.',
    schema: {
      type: 'object',
      properties: {
        scanned: { type: 'number' },
        expired: { type: 'number' },
        skipped: { type: 'number' },
        durationMs: { type: 'number' },
      },
    },
  })
  @ApiProduces('application/json')
  public async sweepReservations(
    @Body() dto: SweepReservationsRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<IReservationSweepResult> {
    return this.sweepReservationsUseCase.execute({
      batchSize: dto.batchSize,
      actorId: actor.id,
      correlationId,
    });
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
    return this.releaseReservationUseCase.execute({
      reservationId,
      reason: 'manual',
      actorId: actor.id,
      correlationId,
    });
  }
}
