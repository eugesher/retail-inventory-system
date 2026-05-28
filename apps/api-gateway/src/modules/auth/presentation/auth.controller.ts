import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser, Public } from '@retail-inventory-system/auth';
import { ICurrentUser } from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.use-case';
import { CurrentUserResponseDto } from './dto/current-user.response.dto';
import { RefreshRequestDto } from './dto/refresh.request.dto';
import { TokenResponseDto } from './dto/token.response.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
  ) {}

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate access + refresh tokens' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token' })
  public async refresh(
    @Body() dto: RefreshRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<TokenResponseDto> {
    const result = await this.refreshTokenUseCase.execute({
      refreshToken: dto.refreshToken,
      correlationId,
    });
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invalidate the current refresh token' })
  public async logout(
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ success: true }> {
    await this.logoutUseCase.execute({ userId: user.id, correlationId });
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user' })
  @ApiOkResponse({ type: CurrentUserResponseDto })
  public me(@CurrentUser() user: ICurrentUser): CurrentUserResponseDto {
    return {
      id: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
    };
  }
}
