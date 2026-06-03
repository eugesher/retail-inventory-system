import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Kebab-case slug: lowercase alphanumeric segments joined by single hyphens.
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Request body for `POST /api/catalog/products`. The catalog domain has the
// final say on name/slug non-emptiness and the repository owns slug uniqueness;
// these decorators are the gateway's edge guard so a malformed request fails
// fast with a 400 before an RPC is dispatched.
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
