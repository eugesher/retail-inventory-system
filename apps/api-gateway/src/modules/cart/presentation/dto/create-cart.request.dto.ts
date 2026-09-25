import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

export class CreateCartRequestDto {
  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO-4217 3-letter code. Omit to use the configured default currency.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter code' })
  public currency?: string;
}
