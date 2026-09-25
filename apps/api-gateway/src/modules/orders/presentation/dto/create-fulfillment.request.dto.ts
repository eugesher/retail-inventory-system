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
