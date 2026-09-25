import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class CapturePaymentRequestDto {
  @ApiPropertyOptional({
    example: 29997,
    minimum: 1,
    description:
      'Optional. Must equal the order grandTotalMinor — partial capture is NOT supported, and any other value is rejected with 422 PARTIAL_CAPTURE_UNSUPPORTED. Omit it to capture the full authorized amount.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public amountMinor?: number;
}
