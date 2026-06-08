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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, Public, RequiresPermission } from '@retail-inventory-system/auth';
import {
  ICurrentUser,
  PermissionCodeEnum,
  StockLevelView,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AdjustStockUseCase,
  GetVariantStockUseCase,
  ListLocationsUseCase,
  ReceiveStockUseCase,
} from '../application/use-cases';
import { AdjustStockRequestDto, ReceiveStockRequestDto, VariantStockQueryDto } from './dto';

// HTTP surface over the inventory microservice's read + write RPCs (ADR-009). The
// gateway holds no inventory state of its own — each method is a thin port→adapter
// pass to `inventory_queue`.
//
// The routes are gated by intent (ADR-024): the per-variant availability read is
// `@Public()`, because an unauthenticated shopper needs to see whether an item is
// in stock before checking out; the stock-location list is operational data, so it
// requires `inventory:read`; the two write routes require `inventory:adjust`.
// Both permission codes are staff-only — customer tokens carry no `permissions`
// claim — so the location list and the writes are staff-only by construction.
@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly getVariantStockUseCase: GetVariantStockUseCase,
    private readonly listLocationsUseCase: ListLocationsUseCase,
    private readonly receiveStockUseCase: ReceiveStockUseCase,
    private readonly adjustStockUseCase: AdjustStockUseCase,
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
}
