import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { RoleEnum, Roles } from '@retail-inventory-system/auth';

// Admin-only smoke endpoint. The retail/inventory routes today only need a
// CUSTOMER-or-ADMIN role; without this, the role guard could not be exercised
// for the admin-vs-customer 403 path. Documented in ADR-010.
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
