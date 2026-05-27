import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule as AuthLibModule, AUTH_USER_VALIDATOR } from '@retail-inventory-system/auth';

import { PASSWORD_HASHER } from '../application/ports/password.port';
import { PERMISSION_REPOSITORY } from '../application/ports/permission.repository.port';
import { ROLE_REPOSITORY } from '../application/ports/role.repository.port';
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
import { PermissionEntity } from './persistence/permission.entity';
import { PermissionTypeormRepository } from './persistence/permission-typeorm.repository';
import { RoleEntity } from './persistence/role.entity';
import { RoleTypeormRepository } from './persistence/role-typeorm.repository';
import { UserEntity } from './persistence/user.entity';
import { UserTypeormRepository } from './persistence/user-typeorm.repository';

// AUTH_USER_VALIDATOR + USER_REPOSITORY are bound inside libs/auth's `forRootAsync`
// so its JwtStrategy can resolve them; re-exported so the use cases below inject
// the same providers without re-registering them.
const authLibProviders = [
  UserTypeormRepository,
  { provide: USER_REPOSITORY, useExisting: UserTypeormRepository },
  ValidateUserUseCase,
  { provide: AUTH_USER_VALIDATOR, useExisting: ValidateUserUseCase },
];

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity]),
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

    RoleTypeormRepository,
    { provide: ROLE_REPOSITORY, useExisting: RoleTypeormRepository },

    PermissionTypeormRepository,
    { provide: PERMISSION_REPOSITORY, useExisting: PermissionTypeormRepository },

    LoginUseCase,
    LogoutUseCase,
    RefreshTokenUseCase,
    RegisterUserUseCase,
  ],
  exports: [
    PASSWORD_HASHER,
    TOKEN_SERVICE,
    RegisterUserUseCase,
    ROLE_REPOSITORY,
    PERMISSION_REPOSITORY,
  ],
})
export class AuthModule {}
