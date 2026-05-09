import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsPositive, ValidateNested } from 'class-validator';

class OrderCreateProductDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  public productId: number;

  @ApiProperty({ example: 2 })
  @IsInt()
  @IsPositive()
  public quantity: number;
}

export class OrderCreateDto {
  @ApiProperty()
  @IsInt()
  @IsPositive()
  public customerId: number;

  @ApiProperty({ type: [OrderCreateProductDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderCreateProductDto)
  public products: OrderCreateProductDto[];
}
