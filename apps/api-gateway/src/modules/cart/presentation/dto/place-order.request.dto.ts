import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

export class AddressInputDto {
  @ApiProperty({ example: 'Jane Buyer' })
  @IsString()
  @IsNotEmpty()
  public recipientName: string;

  @ApiProperty({ example: '1 Market St' })
  @IsString()
  @IsNotEmpty()
  public line1: string;

  @ApiPropertyOptional({ example: 'Suite 400' })
  @IsOptional()
  @IsString()
  public line2?: string;

  @ApiProperty({ example: 'San Francisco' })
  @IsString()
  @IsNotEmpty()
  public city: string;

  @ApiProperty({ example: 'CA' })
  @IsString()
  @IsNotEmpty()
  public region: string;

  @ApiProperty({ example: '94105' })
  @IsString()
  @IsNotEmpty()
  public postalCode: string;

  @ApiProperty({ example: 'US', minLength: 2, maxLength: 2 })
  @IsString()
  @Length(2, 2)
  public country: string;

  @ApiPropertyOptional({ example: '+1-415-555-0100' })
  @IsOptional()
  @IsString()
  public phone?: string;
}

export class PlaceOrderRequestDto {
  @ApiProperty({ type: AddressInputDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => AddressInputDto)
  public shippingAddress: AddressInputDto;

  @ApiProperty({ type: AddressInputDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => AddressInputDto)
  public billingAddress: AddressInputDto;

  @ApiPropertyOptional({
    example: 'tok_visa',
    description: 'Opaque payment-method token forwarded to the payment gateway',
  })
  @IsOptional()
  @IsString()
  public paymentMethod?: string;
}
