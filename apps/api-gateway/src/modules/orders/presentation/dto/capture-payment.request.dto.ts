import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// Request body for `POST /api/orders/:orderId/payments/capture`.
//
// **`amountMinor` is optional, and the only value it may take is the order's grand total.** The
// payment gateway's `capture(gatewayReference)` takes no amount, so the full authorized figure is
// the only thing that can move — there is no partial capture to ask for. Any other value is
// rejected with `422 PARTIAL_CAPTURE_UNSUPPORTED`.
//
// It used to be **accepted and silently dropped**: a caller asking for `1000` against a `29997`
// order was charged in full and got a `200` that contradicted nothing (ISSUE-09). **The description
// below is the artefact that mattered.** It is the one thing an external integrator reads, on the
// one route where being wrong moves money, and they cannot check it against the source. The field
// survives — unimplemented but honest — so a real partial capture has somewhere to land.
//
// **The gateway DTO is not the enforcement point.** An RPC `@MessagePattern` has no pipe in front of
// it, so the retail use case rejects the mismatch itself; these decorators only fail a bad HTTP
// request faster.
//
// The `Idempotency-Key` is read from the header (not the body) — it is
// **required and deduped** (ADR-036, via the `@IdempotencyKey()` decorator): same key +
// same body replays the stored order, a different body is 422, a missing key is 400. **It never
// protected the amount**: the fingerprint hashes the body, so "retry with a smaller amount" is a
// different key and a fresh execution, not a replay.
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
