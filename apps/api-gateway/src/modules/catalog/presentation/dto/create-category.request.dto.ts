import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

import { SLUG_PATTERN, SLUG_REGEX } from './validation.constants';

// Request body for `POST /api/catalog/categories`. The catalog domain has the
// final say on every invariant and the repository owns slug uniqueness; these
// decorators are the gateway's edge guard so a malformed request fails fast with a
// 400 before an RPC is dispatched. `parentSlug` is optional — omit it to create a
// root category; supply a parent slug to nest the new category under it.
export class CreateCategoryRequestDto {
  @ApiProperty({ example: 'Menswear', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public name: string;

  @ApiProperty({
    example: 'menswear',
    description: 'URL-safe kebab-case identifier (a path segment, globally unique)',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(SLUG_REGEX, { message: 'slug must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)' })
  public slug: string;

  @ApiPropertyOptional({
    example: 'apparel',
    description: 'Slug of the parent category; omit to create a root category',
    pattern: SLUG_PATTERN,
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG_REGEX, { message: 'parentSlug must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)' })
  public parentSlug?: string;

  @ApiPropertyOptional({ example: 0, minimum: 0, description: 'Sibling ordering (lower first)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  public sortOrder?: number;
}
