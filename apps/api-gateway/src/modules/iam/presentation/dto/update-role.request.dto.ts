import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

export class UpdateRoleRequestDto {
  @ApiPropertyOptional({ example: 'Updated description' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public description?: string;

  @ApiPropertyOptional({ enum: PermissionCodeEnum, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public permissionCodes?: PermissionCodeEnum[];
}
