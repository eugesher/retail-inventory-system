import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { Public } from '@retail-inventory-system/auth';
import { CorrelationId } from '@retail-inventory-system/observability';

import { LoginUseCase } from '../application/use-cases/login.use-case';
import { LoginRequestDto } from './dto/login.request.dto';
import { TokenResponseDto } from './dto/token.response.dto';

// Multi-prefix: `/auth/login` is the deprecated alias kept for one release
// (epic-01 §"Old route kept as deprecated alias"); `/auth/staff/login` is the
// new canonical path. Both delegate to the same LoginUseCase, so behaviour is
// identical — only the URL differs, which is what "deprecation" means here.
@ApiTags('Auth — Staff')
@Controller(['auth', 'auth/staff'])
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
