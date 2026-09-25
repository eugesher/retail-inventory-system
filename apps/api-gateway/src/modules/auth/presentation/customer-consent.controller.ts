import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@retail-inventory-system/auth';
import { ConsentRecordView, ICurrentUser } from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { RecordConsentUseCase, ReadConsentUseCase } from '../application/use-cases';
import { RecordConsentRequestDto } from './dto';

@ApiTags('Auth — Customer Consent')
@ApiBearerAuth()
@Controller('auth/customer/me/consent')
export class CustomerConsentController {
  constructor(
    private readonly readConsentUseCase: ReadConsentUseCase,
    private readonly recordConsentUseCase: RecordConsentUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Return the channel-consent record for the authenticated customer' })
  @ApiOkResponse({ type: ConsentRecordView })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  public async getConsent(@CurrentUser() user: ICurrentUser): Promise<ConsentRecordView> {
    return this.readConsentUseCase.execute({
      customerId: user.id,
      requesterId: user.id,
      isStaff: false,
    });
  }

  @Put()
  @ApiOperation({
    summary: 'Update the channel-consent preferences for the authenticated customer',
  })
  @ApiOkResponse({ type: ConsentRecordView })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  public async putConsent(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: RecordConsentRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<ConsentRecordView> {
    return this.recordConsentUseCase.execute({
      customerId: user.id,
      transactionalEmail: dto.transactionalEmail,
      marketingEmail: dto.marketingEmail,
      marketingSms: dto.marketingSms,
      dataRetentionPolicy: dto.dataRetentionPolicy,
      correlationId,
    });
  }
}
