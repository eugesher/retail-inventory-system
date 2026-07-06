import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

// The `POST /api/admin/customers/:id/erase` body. `confirmEmail` is a deliberate
// operator guard on an irreversible action: the admin must type the customer's
// **current** email, which the use case checks (case-insensitively) against the
// live customer before nulling any PII. A mismatch is a `400` and nothing is erased.
export class EraseCustomerRequestDto {
  @ApiProperty({
    example: 'buyer@example.com',
    description: 'The customer’s current email, retyped to confirm the erase',
  })
  @IsString()
  @IsEmail()
  public confirmEmail: string;
}
