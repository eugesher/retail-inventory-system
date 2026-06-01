import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

const ROLE_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

export class CreateRoleRequestDto {
  @ApiProperty({ example: 'audit-only', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(ROLE_NAME_REGEX, {
    message: 'name must match ^[a-z][a-z0-9-]*$',
  })
  public name: string;

  @ApiPropertyOptional({ example: 'Audit log read-only access' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public description?: string;

  @ApiProperty({ enum: PermissionCodeEnum, isArray: true, example: ['audit:read'] })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public permissionCodes: PermissionCodeEnum[];
}
