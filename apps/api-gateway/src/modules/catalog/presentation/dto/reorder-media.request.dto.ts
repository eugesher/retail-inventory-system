import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsEnum, IsInt, IsPositive } from 'class-validator';

import { MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

export class ReorderMediaRequestDto {
  @ApiProperty({ enum: MediaOwnerTypeEnum, example: MediaOwnerTypeEnum.PRODUCT })
  @IsEnum(MediaOwnerTypeEnum)
  public ownerType: MediaOwnerTypeEnum;

  @ApiProperty({ example: 1, description: 'BIGINT id of the owning product or product-variant' })
  @IsInt()
  @IsPositive()
  public ownerId: number;

  @ApiProperty({
    type: [Number],
    example: [3, 1, 2],
    description: 'The owner active media ids in their desired order (an exact permutation)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @IsPositive({ each: true })
  public mediaIdsInOrder: number[];
}
