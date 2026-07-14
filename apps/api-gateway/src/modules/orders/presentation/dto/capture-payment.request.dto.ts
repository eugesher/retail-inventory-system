import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// Request body for `POST /api/orders/:orderId/payments/capture`.
//
// **`amountMinor` is accepted and then ignored.** It is validated here, forwarded over RPC, and
// dropped: the payment gateway's `capture(gatewayReference)` takes no amount, so the full
// authorized amount is always what moves. A caller that supplies a smaller figure is charged in
// full and still gets a `200`. Do not read this field as a partial-capture control.
//
// The `Idempotency-Key` is read from the header (not the body) — it is
// **required and deduped** (ADR-036, via the `@IdempotencyKey()` decorator): same key +
// same body replays the stored order, a different body is 422, a missing key is 400.
export class CapturePaymentRequestDto {
  @ApiPropertyOptional({
    example: 29997,
    minimum: 1,
    description:
      'ACCEPTED BUT IGNORED — partial capture is not supported. The full authorized amount is always captured, whatever is sent here.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public amountMinor?: number;
}
