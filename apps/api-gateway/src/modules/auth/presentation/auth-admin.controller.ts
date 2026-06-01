import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { RequiresPermission } from '@retail-inventory-system/auth';
import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

// Smoke endpoint for the global guard chain: JwtAuthGuard (auth),
// RolesGuard (any authenticated user passes — no `@Roles()` here),
// and the new PermissionsGuard which gates on the `audit:read` code
// bundled into the seeded admin role. See ADR-024.
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
