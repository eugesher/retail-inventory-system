import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, Matches } from 'class-validator';

import { SLUG_REGEX } from './validation.constants';

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
