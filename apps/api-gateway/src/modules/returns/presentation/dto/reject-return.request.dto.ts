import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Request body for `POST /api/returns/:rmaId/reject`. `reason` is the required rejection
// reason — the retail use case appends it to the RMA's `notes` (no schema change) and
// rides it on the `retail.return.rejected` event so the buyer can be told why. A reject
// without a reason is a 400 at the edge.
export class RejectReturnRequestDto {
  @ApiProperty({
    example: 'Outside the return window',
    description: 'Human-readable rejection reason (recorded on the RMA + the event)',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason: string;
}
