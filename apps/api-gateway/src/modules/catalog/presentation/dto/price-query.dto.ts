import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

import { CURRENCY_CODE_PATTERN, CURRENCY_CODE_REGEX } from './validation.constants';

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
