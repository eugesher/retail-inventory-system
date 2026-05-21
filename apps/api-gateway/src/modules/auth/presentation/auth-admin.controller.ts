import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { RoleEnum, Roles } from '@retail-inventory-system/auth';

// Exists to cover the RolesGuard 403 path — the retail/inventory routes
// only require CUSTOMER-or-ADMIN, leaving the admin-vs-customer rejection
// otherwise unexercised. See ADR-010.
@ApiTags('Auth (admin)')
@Controller('auth/admin')
export class AuthAdminController {
  @Get('ping')
  @Roles(RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOkResponse({ schema: { example: { ok: true } } })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  public ping(): { ok: true } {
    return { ok: true };
  }
}
