import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser, Public } from '@retail-inventory-system/auth';
import { ICurrentUser } from '@retail-inventory-system/contracts';

import { GetCurrentCustomerUseCase } from '../application/use-cases/get-current-customer.use-case';
import { LoginCustomerUseCase } from '../application/use-cases/login-customer.use-case';
import { RegisterCustomerUseCase } from '../application/use-cases/register-customer.use-case';
import { CurrentCustomerResponseDto } from './dto/current-customer.response.dto';
import { LoginCustomerRequestDto } from './dto/login-customer.request.dto';
import { RegisterCustomerRequestDto } from './dto/register-customer.request.dto';
import { TokenResponseDto } from './dto/token.response.dto';

@ApiTags('Auth — Customer')
@Controller('auth/customer')
export class CustomerAuthController {
  constructor(
    private readonly registerUseCase: RegisterCustomerUseCase,
    private readonly loginUseCase: LoginCustomerUseCase,
    private readonly getCurrentUseCase: GetCurrentCustomerUseCase,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new customer account' })
  @ApiCreatedResponse({ type: CurrentCustomerResponseDto })
  public async register(
    @Body() dto: RegisterCustomerRequestDto,
  ): Promise<CurrentCustomerResponseDto> {
    const customer = await this.registerUseCase.execute({
      email: dto.email,
      password: dto.password,
      firstName: dto.firstName ?? null,
      lastName: dto.lastName ?? null,
      phone: dto.phone ?? null,
    });

    return {
      id: customer.id,
      email: customer.email,
      status: customer.status,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      emailVerifiedAt: customer.emailVerifiedAt?.toISOString() ?? null,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate a customer with email + password' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  public async login(@Body() dto: LoginCustomerRequestDto): Promise<TokenResponseDto> {
    const result = await this.loginUseCase.execute(dto);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated customer profile' })
  @ApiOkResponse({ type: CurrentCustomerResponseDto })
  public async me(@CurrentUser() user: ICurrentUser): Promise<CurrentCustomerResponseDto> {
    const customer = await this.getCurrentUseCase.execute(user.id);
    return {
      id: customer.id,
      email: customer.email,
      status: customer.status,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      emailVerifiedAt: customer.emailVerifiedAt?.toISOString() ?? null,
    };
  }
}
