import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsString } from 'class-validator';

export class AssignStaffRoleRequestDto {
  @ApiProperty({ type: String, isArray: true, example: ['warehouse-staff'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  public roleNames: string[];
}
