import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

// Request body for `PATCH /api/notifications/templates/:id/active`. Flips one
// template **version**'s soft-delete flag — `true` re-activates, `false` deactivates
// (the rollback lever). The `:id` arrives on the path (`ParseIntPipe`); the body
// carries only the target flag.
export class SetTemplateActiveRequestDto {
  @ApiProperty({
    example: false,
    description: 'Target active flag — false deactivates the version, true re-activates it',
  })
  @IsBoolean()
  public active: boolean;
}
