import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

// UPPER_SNAKE_CASE classification code (matches `CreateTaxCategoryRequestDto`).
const TAX_CATEGORY_CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;

// Request body for `PATCH /api/catalog/variants/:variantId/tax-category`. The
// variant is addressed by the route param; the category by its stable `code`
// (not its surrogate id) so the caller references a label it already knows by
// code. An unknown code → 404 (`TAX_CATEGORY_NOT_FOUND`) downstream.
export class AttachTaxCategoryRequestDto {
  @ApiProperty({
    example: 'STANDARD',
    description: 'Stable UPPER_SNAKE_CASE tax-category code',
    pattern: '^[A-Z][A-Z0-9_]*$',
  })
  @Matches(TAX_CATEGORY_CODE_REGEX, {
    message: 'taxCategoryCode must be UPPER_SNAKE_CASE (^[A-Z][A-Z0-9_]*$)',
  })
  public taxCategoryCode: string;
}
