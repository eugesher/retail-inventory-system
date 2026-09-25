import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { RequiresPermission } from '@retail-inventory-system/auth';
import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

@ApiTags('Auth (admin)')
@Controller('auth/admin')
export class AuthAdminController {
  @Get('ping')
  @RequiresPermission(PermissionCodeEnum.AUDIT_READ)
  @ApiBearerAuth()
  @ApiOkResponse({ schema: { example: { ok: true } } })
  @ApiForbiddenResponse({ description: 'audit:read permission required' })
  public ping(): { ok: true } {
    return { ok: true };
  }
}
