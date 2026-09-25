import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

import { TAX_CATEGORY_CODE_PATTERN, TAX_CATEGORY_CODE_REGEX } from './validation.constants';

export class AttachTaxCategoryRequestDto {
  @ApiProperty({
    example: 'STANDARD',
    description: 'Stable UPPER_SNAKE_CASE tax-category code',
    pattern: TAX_CATEGORY_CODE_PATTERN,
  })
  @Matches(TAX_CATEGORY_CODE_REGEX, {
    message: `taxCategoryCode must be UPPER_SNAKE_CASE (${TAX_CATEGORY_CODE_PATTERN})`,
  })
  public taxCategoryCode: string;
}
