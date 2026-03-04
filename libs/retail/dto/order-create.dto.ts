import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

export class OrderItemDto {
  @ApiProperty({ example: 'prod-001' })
  @IsString()
  @IsNotEmpty()
  public productId: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @IsPositive()
  public quantity: number;

  @ApiProperty({ example: 'store-001' })
  @IsString()
  @IsOptional()
  public storageId?: string;
}

export class OrderCreateDto {
  @ApiProperty({ example: 'cust-123' })
  @IsString()
  @IsNotEmpty()
  public customerId: string;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  public items: OrderItemDto[];

  @ApiProperty({ example: 'Belgrade, Serbia' })
  @IsString()
  @IsNotEmpty()
  public shippingAddress: string;
}
