import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class TransferStockRequestDto {
  @ApiProperty({
    example: 'default-warehouse',
    description: 'Source stock location id (debited)',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public fromLocationId: string;

  @ApiProperty({
    example: 'backup-store',
    description: 'Destination stock location id (credited)',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public toLocationId: string;

  @ApiProperty({
    example: 5,
    description: 'Positive whole number of units to move from source to destination',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  public quantity: number;
}
