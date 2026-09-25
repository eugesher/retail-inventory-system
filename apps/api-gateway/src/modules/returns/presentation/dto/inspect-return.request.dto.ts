import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEnum, IsInt, Min, ValidateNested } from 'class-validator';

import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';

export class InspectReturnLineInputDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'The RMA return line id' })
  @IsInt()
  @Min(1)
  public returnLineId: number;

  @ApiProperty({
    enum: ReturnLineConditionEnum,
    example: ReturnLineConditionEnum.NEW,
    description: 'Physical condition the returned goods arrived in',
  })
  @IsEnum(ReturnLineConditionEnum)
  public condition: ReturnLineConditionEnum;

  @ApiProperty({
    enum: ReturnDispositionEnum,
    example: ReturnDispositionEnum.RESTOCK,
    description: 'What happens to the goods; only `restock` re-enters sellable inventory',
  })
  @IsEnum(ReturnDispositionEnum)
  public disposition: ReturnDispositionEnum;

  @ApiProperty({
    example: 4999,
    minimum: 0,
    description: 'Refund amount this line earns, in integer minor units (cents)',
  })
  @IsInt()
  @Min(0)
  public lineRefundAmountMinor: number;
}

export class InspectReturnRequestDto {
  @ApiProperty({ type: [InspectReturnLineInputDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectReturnLineInputDto)
  public lines: InspectReturnLineInputDto[];
}
