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

// One address bundle on the Place Order body. Required fields are non-empty;
// `country` is exactly 2 chars (the ISO-3166 alpha-2 code the retail domain
// upper-cases + re-validates). `line2` / `phone` are optional. At place-time the
// retail side snapshots each bundle as an immutable `ownerType=order` `Address`
// (ADR-028 §5).
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

// Request body for `POST /api/cart/:cartId/place`. The `Idempotency-Key` is read
// from the header, not the body (accepted + forwarded, not enforced — Q10). The
// `customerId` is never sent by the caller — the controller folds in
// `@CurrentUser().id` and the retail use case re-asserts ownership. `@ValidateNested`
// + `@Type` make class-validator recurse into the two address bundles.
export class PlaceOrderRequestDto {
  // `@IsDefined` is load-bearing: `@ValidateNested` is silently skipped on an
  // undefined value, so without it a `{}` body sails past the edge and is only
  // rejected by the domain inside the place transaction.
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
