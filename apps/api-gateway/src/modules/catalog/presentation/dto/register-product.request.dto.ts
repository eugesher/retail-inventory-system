import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { SLUG_PATTERN, SLUG_REGEX } from './validation.constants';

export class RegisterProductRequestDto {
  @ApiProperty({ example: 'Aeron Chair', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  public name: string;

  @ApiProperty({
    example: 'aeron-chair',
    description: 'Globally-unique, URL-safe kebab-case identifier',
    minLength: 1,
    maxLength: 255,
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(SLUG_REGEX, { message: 'slug must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)' })
  public slug: string;

  @ApiPropertyOptional({ example: 'Ergonomic office chair', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public description?: string;
}
