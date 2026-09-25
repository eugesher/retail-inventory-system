import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class AddLineRequestDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'Catalog variant id' })
  @IsInt()
  @Min(1)
  public variantId: number;

  @ApiProperty({ example: 2, minimum: 1, description: 'Units to add' })
  @IsInt()
  @Min(1)
  public quantity: number;
}
