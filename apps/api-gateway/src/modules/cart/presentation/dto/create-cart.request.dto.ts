import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

// Request body for `POST /api/cart`. Both fields are optional — a cart can be
// opened empty and the currency defaults to USD retail-side. The cart domain has
// the final say (a malformed currency is rejected `CART_CURRENCY_INVALID`); this
// decorator is the gateway's edge guard so a bad request fails fast with a 400.
export class CreateCartRequestDto {
  @ApiPropertyOptional({ example: 'USD', description: 'ISO-4217 3-letter code (defaults to USD)' })
  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter code' })
  public currency?: string;
}
