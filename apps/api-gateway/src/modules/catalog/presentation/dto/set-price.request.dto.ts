import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsOptional, Matches, Min } from 'class-validator';

// Request body for `POST /api/catalog/variants/:variantId/prices`. The owning
// variant is taken from the route param, not the body. One body backs both Set
// and Schedule — omit `validFrom` (or pass one `<= now`) for an immediate price,
// pass a future `validFrom` to schedule one. The pricing domain has the final
// say on every invariant (a `validFrom` strictly before now is rejected with
// `PRICE_VALID_FROM_IN_PAST`, `validFrom < validTo`, integer amount/priority);
// these decorators are the gateway's edge guard so a malformed request fails
// fast with a 400 before an RPC is dispatched.
export class SetPriceRequestDto {
  @ApiProperty({ example: 'USD', description: 'ISO-4217 3-letter code', pattern: '^[A-Z]{3}$' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO-4217 code' })
  public currency: string;

  @ApiProperty({ example: 1999, minimum: 0, description: 'Integer count of minor units (cents)' })
  @IsInt()
  @Min(0)
  public amountMinor: number;

  @ApiPropertyOptional({
    example: '2026-07-01T00:00:00.000Z',
    description:
      'ISO-8601 interval start; omitted/`<= now` is immediate, a future instant schedules',
  })
  @IsOptional()
  @IsISO8601()
  public validFrom?: string;

  @ApiPropertyOptional({
    example: '2026-12-31T23:59:59.000Z',
    description: 'ISO-8601 close instant; omitted means open-ended',
  })
  @IsOptional()
  @IsISO8601()
  public validTo?: string;

  @ApiPropertyOptional({ example: 0, description: 'Resolution tiebreak (default 0)' })
  @IsOptional()
  @IsInt()
  public priority?: number;
}
