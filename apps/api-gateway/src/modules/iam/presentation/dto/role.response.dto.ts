import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

export class RoleResponseDto {
  @ApiProperty({ example: '00000000-0000-4000-c000-000000000001' })
  public id: string;

  @ApiProperty({ example: 'admin' })
  public name: string;

  @ApiPropertyOptional({ example: 'Full access to every permission code' })
  public description: string | null;

  @ApiProperty({ enum: PermissionCodeEnum, isArray: true })
  public permissionCodes: PermissionCodeEnum[];
}
