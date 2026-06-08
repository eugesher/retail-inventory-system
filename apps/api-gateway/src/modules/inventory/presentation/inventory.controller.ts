import { Controller, Get, Param, ParseBoolPipe, ParseIntPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { Public, RequiresPermission } from '@retail-inventory-system/auth';
import {
  PermissionCodeEnum,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { GetVariantStockUseCase, ListLocationsUseCase } from '../application/use-cases';
import { VariantStockQueryDto } from './dto';

// HTTP surface over the inventory microservice's two read RPCs (ADR-009). The
// gateway holds no inventory state of its own — each method is a thin port→adapter
// pass to `inventory_queue`.
//
// The two routes are gated differently on purpose (ADR-024): the stock-location
// list is operational data, so it requires the `inventory:read` permission (a
// staff-only code — customer tokens carry no `permissions` claim); the per-variant
// availability read is `@Public()`, because an unauthenticated shopper needs to
// see whether an item is in stock before checking out.
@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly getVariantStockUseCase: GetVariantStockUseCase,
    private readonly listLocationsUseCase: ListLocationsUseCase,
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
}
