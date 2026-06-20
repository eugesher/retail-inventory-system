import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ReturnReasonCategoryEnum } from '@retail-inventory-system/contracts';

// One line on the Open Return body — which `OrderLine` quantity is coming back.
// `orderLineId` points back at the placed order's line; `quantity` is a positive integer
// count of units. The retail use case enforces the returnable-quantity invariant
// (requested ≤ ordered − cancelled − already-returned) — the gateway only validates the
// shape here.
export class OpenReturnLineInputDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'The placed order line id' })
  @IsInt()
  @Min(1)
  public orderLineId: number;

  @ApiProperty({ example: 1, minimum: 1, description: 'Units of that line being returned' })
  @IsInt()
  @Min(1)
  public quantity: number;
}

// Request body for `POST /api/orders/:orderId/returns`. `reasonCategory` is the coarse
// return reason fixed at Open time; `notes` is an optional free-text buyer note. `lines`
// must be a non-empty array of `OpenReturnLineInputDto`; `@ValidateNested({ each: true })`
// + `@Type` make class-validator recurse into each entry, and `@ArrayNotEmpty` rejects an
// empty return at the edge (the domain `ReturnRequest.open` is the backstop). The
// `customerId` / staff-override flag are never sent by the caller — the controller folds
// in `@CurrentUser()` and resolves the override from its permissions.
export class OpenReturnRequestDto {
  @ApiProperty({
    enum: ReturnReasonCategoryEnum,
    example: ReturnReasonCategoryEnum.DEFECTIVE,
    description: 'Why the buyer is returning the goods (coarse classification)',
  })
  @IsEnum(ReturnReasonCategoryEnum)
  public reasonCategory: ReturnReasonCategoryEnum;

  @ApiPropertyOptional({
    example: 'Item arrived with a cracked screen',
    description: 'Optional free-text buyer note',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public notes?: string;

  @ApiProperty({ type: [OpenReturnLineInputDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OpenReturnLineInputDto)
  public lines: OpenReturnLineInputDto[];
}
