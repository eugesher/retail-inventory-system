import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule as AuthLibModule, AUTH_USER_VALIDATOR } from '@retail-inventory-system/auth';

import { PASSWORD_HASHER } from '../application/ports/password.port';
import { TOKEN_SERVICE } from '../application/ports/token.port';
import { USER_REPOSITORY } from '../application/ports/user.repository.port';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.use-case';
import { RegisterUserUseCase } from '../application/use-cases/register-user.use-case';
import { ValidateUserUseCase } from '../application/use-cases/validate-user.use-case';
import { AuthAdminController } from '../presentation/auth-admin.controller';
import { AuthController } from '../presentation/auth.controller';
import { Argon2PasswordAdapter } from './argon2/argon2-password.adapter';
import { JwtTokenAdapter } from './jwt/jwt-token.adapter';
import { UserEntity } from './persistence/user.entity';
import { UserTypeormRepository } from './persistence/user-typeorm.repository';

// libs/auth registers its JwtStrategy which depends on AUTH_USER_VALIDATOR.
// We supply the validator (ValidateUserUseCase) and the repository it needs
// inside `forRootAsync` so the lib module's DI graph is self-contained;
// the bindings are also exported so the use-cases below can inject them
// without re-registering providers.
const authLibProviders = [
  UserTypeormRepository,
  { provide: USER_REPOSITORY, useExisting: UserTypeormRepository },
  ValidateUserUseCase,
  { provide: AUTH_USER_VALIDATOR, useExisting: ValidateUserUseCase },
];

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    AuthLibModule.forRootAsync({
      imports: [TypeOrmModule.forFeature([UserEntity])],
      providers: authLibProviders,
      exports: [USER_REPOSITORY, AUTH_USER_VALIDATOR, ValidateUserUseCase],
    }),
  ],
  controllers: [AuthController, AuthAdminController],
  providers: [
    Argon2PasswordAdapter,
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordAdapter },

    JwtTokenAdapter,
    { provide: TOKEN_SERVICE, useExisting: JwtTokenAdapter },

    LoginUseCase,
    LogoutUseCase,
    RefreshTokenUseCase,
    RegisterUserUseCase,
  ],
  exports: [PASSWORD_HASHER, TOKEN_SERVICE, RegisterUserUseCase],
})
export class AuthModule {}
