import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEnum, IsInt, Min, ValidateNested } from 'class-validator';

import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';

// One line on the Inspect body — the per-`ReturnLine` inspection outcome. `returnLineId`
// points at the RMA line; `condition` is the physical state the goods arrived in;
// `disposition` decides what happens to them (`restock` is the only one that re-enters
// sellable inventory); `lineRefundAmountMinor` is the amount this line earns in integer
// minor units (`@Min(0)` — a zero-refund line is valid). The retail use case requires the
// set to cover every RMA line, so a complete one-entry-per-line array is expected.
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

// Request body for `POST /api/returns/:rmaId/inspect`. `lines` must be a non-empty array
// of `InspectReturnLineInputDto`; `@ValidateNested({ each: true })` + `@Type` make
// class-validator recurse into each entry, and `@ArrayNotEmpty` rejects an empty
// inspection at the edge. The retail use case is the backstop: it requires exactly one
// entry per RMA line (an unknown line is 404, an incomplete/duplicate set 400). The
// `actorId` is never sent by the caller — the controller folds in `@CurrentUser()` and
// the route's `@RequiresPermission('inventory:receive-return')` gate.
export class InspectReturnRequestDto {
  @ApiProperty({ type: [InspectReturnLineInputDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectReturnLineInputDto)
  public lines: InspectReturnLineInputDto[];
}
