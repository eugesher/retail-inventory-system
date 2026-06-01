import { ApiProperty } from '@nestjs/swagger';

export class StaffRolesResponseDto {
  @ApiProperty({ example: '00000000-0000-4000-a000-000000000001' })
  public id: string;

  @ApiProperty({ example: 'admin@example.com' })
  public email: string;

  @ApiProperty({ type: String, isArray: true, example: ['admin'] })
  public roleNames: string[];
}
