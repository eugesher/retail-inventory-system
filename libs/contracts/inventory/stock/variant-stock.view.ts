import { ApiResponseProperty } from '@nestjs/swagger';

import { StockLevelView } from './stock-level.view';

export class VariantStockView {
  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public totalOnHand: number;

  @ApiResponseProperty()
  public totalAvailable: number;

  @ApiResponseProperty({ type: [StockLevelView] })
  public locations: StockLevelView[];
}
