import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ShipFulfillmentRequestDto {
  @ApiPropertyOptional({
    example: '1Z999AA10123456784',
    description: 'Carrier tracking number; required to mark the fulfillment shipped',
  })
  @IsOptional()
  @IsString()
  public trackingNumber?: string;

  @ApiPropertyOptional({ example: 'UPS', description: 'Shipping carrier name' })
  @IsOptional()
  @IsString()
  public carrier?: string;
}
