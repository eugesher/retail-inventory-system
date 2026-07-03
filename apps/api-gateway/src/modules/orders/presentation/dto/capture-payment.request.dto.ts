import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// Request body for `POST /api/orders/:orderId/payments/capture`. `amountMinor` is
// optional and defaults downstream to the order's `grandTotalMinor` (partial capture is a
// later capability). The `Idempotency-Key` is read from the header (not the body) — it is
// **required and deduped** (ADR-036, via the `@IdempotencyKey()` decorator): same key +
// same body replays the stored order, a different body is 422, a missing key is 400. A
// supplied `amountMinor` must be a positive integer count of minor units (cents).
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
