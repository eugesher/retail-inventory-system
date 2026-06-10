import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// Request body for `POST /api/orders/:orderId/payments/capture`. Both fields are
// optional: `amountMinor` defaults downstream to the order's `grandTotalMinor`
// (partial capture is a later capability), and the `Idempotency-Key` is read from the
// header (not the body) — accepted + forwarded, not deduped (Q10). A supplied
// `amountMinor` must be a positive integer count of minor units (cents).
export class CapturePaymentRequestDto {
  @ApiPropertyOptional({
    example: 29997,
    minimum: 1,
    description: 'Amount to capture in minor units; defaults to the order grand total',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public amountMinor?: number;
}
