import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { Public } from '@retail-inventory-system/auth';
import { CorrelationId } from '@retail-inventory-system/observability';

import { LoginUseCase } from '../application/use-cases';
import { LoginRequestDto, TokenResponseDto } from './dto';

// One route, one prefix (ADR-050). This class used to be `@Controller(['auth', 'auth/staff'])`
// — a second URL, `/auth/login`, described as "the old route kept as a deprecated alias".
// It was never old: both URLs shipped in the same commit, so the alias was back-compat with a
// past that did not exist, and no client ever had to migrate off anything.
@ApiTags('Auth — Staff')
@Controller('auth/staff')
export class StaffLoginController {
  constructor(private readonly loginUseCase: LoginUseCase) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate a staff user with email + password' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  public async login(
    @Body() dto: LoginRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<TokenResponseDto> {
    const result = await this.loginUseCase.execute({
      email: dto.email,
      password: dto.password,
      correlationId,
    });
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
  }
}
