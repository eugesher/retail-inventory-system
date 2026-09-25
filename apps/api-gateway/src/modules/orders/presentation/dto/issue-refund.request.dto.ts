import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

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
