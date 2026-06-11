import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsEnum, IsInt, IsPositive } from 'class-validator';

import { MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

// Request body for `PATCH /api/catalog/media/reorder`. Re-sequences one owner's
// media strip in a single shot. `mediaIdsInOrder` is the desired order of the
// owner's ACTIVE media as media ids — each asset's new `sortOrder` is its array
// index. It must be an EXACT permutation of the owner's active set (same ids, no
// duplicates, no omissions, no foreign or archived ids) or the catalog rejects it
// as 409 `MEDIA_REORDER_SET_MISMATCH` and writes nothing — the reorder is
// all-or-nothing (ADR-029 §4). The edge guard only checks the array is non-empty
// and every entry is a positive integer; the permutation contract is the
// microservice's to enforce against the live active set.
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
