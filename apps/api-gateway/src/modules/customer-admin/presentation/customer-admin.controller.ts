import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, RequiresPermission } from '@retail-inventory-system/auth';
import {
  ConsentRecordView,
  ICurrentUser,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { EraseCustomerUseCase, ReadConsentUseCase } from '../../auth';
import { EraseCustomerRequestDto, EraseCustomerResponseDto } from './dto';

// The admin surface over the `Customer` aggregate at `/api/admin/customers/*`. A
// thin presentation-and-orchestration shell (no `domain/` of its own, the `iam`
// precedent, ADR-024): it injects use cases that `auth.module.ts` exports and owns
// the auth aggregate. Both routes are staff-gated with an explicit
// `@RequiresPermission(...)` — these are admin-only staff overrides
// (`customer:read-consent` / `customer:erase`), never customer-reachable (a
// customer JWT carries no `permissions` claim, ADR-024/037 §7).
@ApiTags('Admin — Customers')
@ApiBearerAuth()
@Controller('admin/customers')
export class CustomerAdminController {
  constructor(
    private readonly readConsent: ReadConsentUseCase,
    private readonly eraseCustomer: EraseCustomerUseCase,
  ) {}

  @Get(':id/consent')
  @RequiresPermission(PermissionCodeEnum.CUSTOMER_READ_CONSENT)
  @ApiOperation({ summary: 'Read any customer’s channel-consent record (admin)' })
  @ApiOkResponse({ type: ConsentRecordView })
  @ApiForbiddenResponse({ description: 'Missing the customer:read-consent permission' })
  public async getConsent(@Param('id') id: string): Promise<ConsentRecordView> {
    // Reuse the owner-or-staff Read Consent use case with the staff override. An
    // absent row resolves to the defaults (never a 404).
    return this.readConsent.execute({ customerId: id, requesterId: id, isStaff: true });
  }

  @Post(':id/erase')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(PermissionCodeEnum.CUSTOMER_ERASE)
  @ApiOperation({ summary: 'Tombstone-erase a customer (null all PII, preserve the id)' })
  @ApiOkResponse({ type: EraseCustomerResponseDto })
  @ApiBadRequestResponse({ description: 'confirmEmail does not match the customer’s email' })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  @ApiForbiddenResponse({ description: 'Missing the customer:erase permission' })
  public async erase(
    @Param('id') id: string,
    @Body() dto: EraseCustomerRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<EraseCustomerResponseDto> {
    // Fold the acting staff principal's id into the command — it is recorded on the
    // audit row + the `customer.erased` event, never inferred downstream.
    // `IEraseCustomerResult` and `EraseCustomerResponseDto` are the same shape
    // (`{ status: 'deleted'; erasedAt: string | null }`), so the use-case result is
    // the response as-is — the method's return type still drives the Swagger schema.
    return this.eraseCustomer.execute({
      customerId: id,
      confirmEmail: dto.confirmEmail,
      actorStaffUserId: actor.id,
      correlationId,
    });
  }
}
