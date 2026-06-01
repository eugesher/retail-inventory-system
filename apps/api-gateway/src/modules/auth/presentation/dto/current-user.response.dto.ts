import { ApiProperty } from '@nestjs/swagger';

import { RoleEnum } from '@retail-inventory-system/contracts';

export class CurrentUserResponseDto {
  @ApiProperty()
  public id: string;

  @ApiProperty()
  public email: string;

  @ApiProperty({ enum: RoleEnum, isArray: true })
  public roles: RoleEnum[];

  @ApiProperty({ type: String, isArray: true })
  public permissions: string[];
}
