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
