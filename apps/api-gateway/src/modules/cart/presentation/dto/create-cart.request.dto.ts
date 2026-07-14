import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

// Request body for `POST /api/cart`. The field is optional — a cart can be opened empty,
// and an omitted currency is resolved retail-side from the server's `DEFAULT_CURRENCY`
// (`RETAIL_DEFAULT_CURRENCY`), the same variable catalog prices against. **Not
// necessarily USD**: that is the shipped default, not a promise, and the gateway does not
// know the answer — do not restate one here. The cart domain has the final say (a
// malformed currency is rejected `CART_CURRENCY_INVALID`); this decorator is the
// gateway's edge guard so a bad request fails fast with a 400.
export class CreateCartRequestDto {
  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO-4217 3-letter code. Omit to use the configured default currency.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter code' })
  public currency?: string;
}
