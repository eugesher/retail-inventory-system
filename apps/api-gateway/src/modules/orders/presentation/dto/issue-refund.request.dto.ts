import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

// Request body for `POST /api/orders/:orderId/refunds`. `paymentId` pins the captured
// payment being reversed (a refund is a sibling of `Payment`); `amountMinor` is the
// refund amount in integer minor units (cents — `@Min(1)`, a refund is strictly
// positive); `reason` is the required human-supplied refund reason (recorded on the
// `refund` row + the audit log). The retail use case has the final say — it validates the
// captured precondition and the refundable ceiling (`payment.amountMinor −
// payment.refundedAmountMinor`) and rejects an over-refund with a 409. The `actorId` is
// never sent by the caller (the controller folds in `@CurrentUser()`); the
// `Idempotency-Key` rides a header, not the body.
export class IssueRefundRequestDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'The captured payment id to refund against' })
  @IsInt()
  @Min(1)
  public paymentId: number;

  @ApiProperty({
    example: 4999,
    minimum: 1,
    description: 'Refund amount in integer minor units (cents)',
  })
  @IsInt()
  @Min(1)
  public amountMinor: number;

  @ApiProperty({
    example: 'Returned item refunded',
    description: 'Human-readable refund reason (recorded on the refund row + the audit log)',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public reason: string;
}
