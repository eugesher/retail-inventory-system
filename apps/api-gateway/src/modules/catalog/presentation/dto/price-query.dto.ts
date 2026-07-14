import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

import { CURRENCY_CODE_PATTERN, CURRENCY_CODE_REGEX } from './validation.constants';

// Query string shared by `GET /api/catalog/variants/:variantId/prices` (list) and
// `GET /api/catalog/variants/:variantId/price` (single applicable). Both ask the same
// `(variantId, currency)`-scoped question at a point in time.
//
// **`currency` no longer defaults HERE, and that is the fix** (ISSUE-11). It used to carry
// `public currency = 'USD'` — a field initializer the global `ValidationPipe` (`transform: true`)
// keeps, so an omitted `?currency=` put `USD` on the wire on the caller's behalf. On a shop configured
// `DEFAULT_CURRENCY=EUR` the catalog holds only EUR prices, so both of these `@Public()` reads asked
// for a currency the catalog does not stock and **found nothing, for every variant**. A correctly
// configured shop could not display a price.
//
// The default is now resolved one layer in, by the gateway use cases, from
// `CATALOG_GATEWAY_DEFAULT_CURRENCY` ← `DEFAULT_CURRENCY` — the same variable the catalog prices
// against. **It is still a gateway concern**, exactly as `IPriceQuery`'s comment says it should be
// (*"the currency scope is required on the wire — defaulting it is a gateway-DTO concern, not a
// contract one"*). That decision was right; only the *source* of the default was wrong. A DTO cannot
// inject `ConfigService`, so the default could not be made configurable in place — it had to move.
//
// **`asOf`'s initializer stays.** "Now" is not configurable and never was.
export class PriceQueryDto {
  @ApiPropertyOptional({
    example: 'USD',
    description:
      'ISO-4217 3-letter code. Omit to scope the query to the configured default currency of this deployment.',
    pattern: CURRENCY_CODE_PATTERN,
  })
  @IsOptional()
  @Matches(CURRENCY_CODE_REGEX, { message: 'currency must be a 3-letter uppercase ISO-4217 code' })
  public currency?: string;

  @ApiPropertyOptional({
    example: '2026-07-01T00:00:00.000Z',
    description: 'As-of instant (ISO-8601); defaults to now',
  })
  @IsOptional()
  @IsISO8601()
  public asOf: string = new Date().toISOString();
}
