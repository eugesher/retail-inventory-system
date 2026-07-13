import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

// `POST /api/iam/staff`. The password rules mirror `RegisterCustomerRequestDto` — the same
// argon2 hasher is behind both, so a stricter policy here would be theatre.
//
// `roleNames` is REQUIRED and non-empty, unlike the customer registration it otherwise
// resembles: a staff user with no role is a principal that can authenticate and do nothing,
// which is a worse outcome than a rejected request. `RegisterStaffUserUseCase` enforces the
// same rule (it is reachable over RPC-less DI from elsewhere), so this DTO is the fast path,
// not the only gate.
export class CreateStaffUserRequestDto {
  @ApiProperty({ example: 'warehouse@example.com' })
  @IsEmail()
  @MaxLength(255)
  public email: string;

  @ApiProperty({ example: 'warehouse1234' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password: string;

  @ApiProperty({ type: String, isArray: true, example: ['warehouse-staff'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  public roleNames: string[];
}
