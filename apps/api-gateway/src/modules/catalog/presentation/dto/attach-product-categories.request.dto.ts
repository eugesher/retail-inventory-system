import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, Matches } from 'class-validator';

import { SLUG_REGEX } from './validation.constants';

// Request body for `POST /api/catalog/products/:productId/categories`. Attaches
// the product to one or more categories named by slug. The product is identified
// by the `:productId` path param; this body carries only the category slugs to
// attach. Each slug must be kebab-case (the catalog domain's `path`-segment
// invariant). The list must be non-empty — an empty attach is a no-op the caller
// never needs to express (the detach route is the dedicated removal path).
//
// The underlying RPC (`catalog.product.reclassify`) is idempotent: re-attaching
// an existing membership is a silent success.
export class AttachProductCategoriesRequestDto {
  @ApiProperty({
    type: [String],
    example: ['menswear', 'sale'],
    description: 'Kebab-case category slugs to attach the product to',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Matches(SLUG_REGEX, {
    each: true,
    message: 'each category slug must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)',
  })
  public categorySlugs: string[];
}
