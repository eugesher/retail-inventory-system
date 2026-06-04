import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// UPPER_SNAKE_CASE classification code: starts with a letter, then letters,
// digits, or underscores.
const TAX_CATEGORY_CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;

// Request body for `POST /api/catalog/tax-categories`. A tax category is a
// classification label only — code + name (+ optional description); it carries no
// rate or jurisdiction (ADR-026). The pricing domain re-validates the code/name
// and the use case owns code uniqueness (a duplicate → 409
// `TAX_CATEGORY_CODE_TAKEN`); these decorators are the gateway's edge guard.
export class CreateTaxCategoryRequestDto {
  @ApiProperty({
    example: 'STANDARD',
    description: 'Stable UPPER_SNAKE_CASE identifier',
    pattern: '^[A-Z][A-Z0-9_]*$',
  })
  @Matches(TAX_CATEGORY_CODE_REGEX, {
    message: 'code must be UPPER_SNAKE_CASE (^[A-Z][A-Z0-9_]*$)',
  })
  public code: string;

  @ApiProperty({ example: 'Standard rate', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public name: string;

  @ApiPropertyOptional({ example: 'The default tax classification', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public description?: string;
}
