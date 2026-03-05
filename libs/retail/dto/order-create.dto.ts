import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsPositive, ValidateNested } from 'class-validator';

export class OrderCreateProductDto {
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
  @ValidateNested({ each: true })
  @Type(() => OrderCreateProductDto)
  public products: OrderCreateProductDto[];
}
