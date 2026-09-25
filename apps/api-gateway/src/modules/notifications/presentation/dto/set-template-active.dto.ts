import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetTemplateActiveRequestDto {
  @ApiProperty({
    example: false,
    description: 'Target active flag — false deactivates the version, true re-activates it',
  })
  @IsBoolean()
  public active: boolean;
}
