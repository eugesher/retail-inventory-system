import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

import { SLUG_PATTERN, SLUG_REGEX } from './validation.constants';

export class ReparentCategoryRequestDto {
  @ApiPropertyOptional({
    example: 'apparel',
    nullable: true,
    description: 'Slug of the new parent; omit or send null to demote to a root category',
    pattern: SLUG_PATTERN,
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG_REGEX, { message: 'newParentSlug must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)' })
  public newParentSlug?: string | null;
}
