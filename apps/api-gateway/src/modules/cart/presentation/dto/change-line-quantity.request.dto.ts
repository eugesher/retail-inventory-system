import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ChangeLineQuantityRequestDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'New line quantity (must be positive)' })
  @IsInt()
  @Min(1)
  public quantity: number;
}
