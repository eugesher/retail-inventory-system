import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

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
