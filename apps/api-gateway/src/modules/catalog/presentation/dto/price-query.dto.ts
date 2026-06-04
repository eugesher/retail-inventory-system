import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

// Query string shared by `GET /api/catalog/variants/:variantId/prices` (list) and
// `GET /api/catalog/variants/:variantId/price` (single applicable). Both ask the
// same `(variantId, currency)`-scoped question at a point in time. The currency
// scope and the as-of instant default here at the edge — `currency` to `USD` and
// `asOf` to now — so the wire always carries them and the answer is deterministic
// for a caller that supplies neither. Field initializers are kept by the global
// `ValidationPipe` (`transform: true`); a supplied `?asOf=`/`?currency=` overrides
// the default and is then shape-validated.
export class PriceQueryDto {
  @ApiPropertyOptional({
    example: 'USD',
    default: 'USD',
    description: 'ISO-4217 3-letter code (defaults to USD)',
    pattern: '^[A-Z]{3}$',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO-4217 code' })
  public currency = 'USD';

  @ApiPropertyOptional({
    example: '2026-07-01T00:00:00.000Z',
    description: 'As-of instant (ISO-8601); defaults to now',
  })
  @IsOptional()
  @IsISO8601()
  public asOf: string = new Date().toISOString();
}
