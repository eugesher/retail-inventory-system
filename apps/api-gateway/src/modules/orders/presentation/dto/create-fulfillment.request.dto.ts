import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

// One line on the Create Fulfillment body — which `OrderLine` quantity is included in
// this shipment. `orderLineId` points back at the placed order's line; `quantity` is a
// positive integer count of units. The retail use case enforces the cross-fulfillment
// sum invariant (already-fulfilled + requested ≤ ordered) — the gateway only validates
// the shape here.
export class FulfillmentLineInputDto {
  @ApiProperty({ example: 1, minimum: 1, description: 'The placed order line id' })
  @IsInt()
  @Min(1)
  public orderLineId: number;

  @ApiProperty({ example: 1, minimum: 1, description: 'Units of that line in this shipment' })
  @IsInt()
  @Min(1)
  public quantity: number;
}

// Request body for `POST /api/orders/:orderId/fulfillments`. `stockLocationId` is
// optional — the retail use case defaults it to `default-warehouse` (multi-location
// sourcing is a later capability). `lines` must be a non-empty array of
// `FulfillmentLineInputDto`; `@ValidateNested({ each: true })` + `@Type` make
// class-validator recurse into each entry, and `@ArrayNotEmpty` rejects an empty
// shipment at the edge (the domain `Fulfillment.create` is the backstop). The
// `actorId` / staff-override flags are never sent by the caller — the controller folds
// in `@CurrentUser()` and the route's `@RequiresPermission('order:fulfill')` gate.
export class CreateFulfillmentRequestDto {
  @ApiPropertyOptional({
    example: 'default-warehouse',
    description: 'Inventory stock location to ship from; defaults to default-warehouse',
  })
  @IsOptional()
  @IsString()
  public stockLocationId?: string;

  @ApiProperty({ type: [FulfillmentLineInputDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => FulfillmentLineInputDto)
  public lines: FulfillmentLineInputDto[];
}
