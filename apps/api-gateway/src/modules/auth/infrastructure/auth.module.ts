import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule as AuthLibModule, AUTH_USER_VALIDATOR } from '@retail-inventory-system/auth';

import { PASSWORD_HASHER } from '../application/ports/password.port';
import { PERMISSION_REPOSITORY } from '../application/ports/permission.repository.port';
import { ROLE_REPOSITORY } from '../application/ports/role.repository.port';
import { STAFF_USER_REPOSITORY } from '../application/ports/staff-user.repository.port';
import { TOKEN_SERVICE } from '../application/ports/token.port';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.use-case';
import { RegisterStaffUserUseCase } from '../application/use-cases/register-staff-user.use-case';
import { ValidateStaffUserUseCase } from '../application/use-cases/validate-staff-user.use-case';
import { AuthAdminController } from '../presentation/auth-admin.controller';
import { AuthController } from '../presentation/auth.controller';
import { Argon2PasswordAdapter } from './argon2/argon2-password.adapter';
import { JwtTokenAdapter } from './jwt/jwt-token.adapter';
import { PermissionEntity } from './persistence/permission.entity';
import { PermissionTypeormRepository } from './persistence/permission-typeorm.repository';
import { RoleEntity } from './persistence/role.entity';
import { RoleTypeormRepository } from './persistence/role-typeorm.repository';
import { StaffUserEntity } from './persistence/staff-user.entity';
import { StaffUserTypeormRepository } from './persistence/staff-user-typeorm.repository';

// AUTH_USER_VALIDATOR + STAFF_USER_REPOSITORY are bound inside libs/auth's
// `forRootAsync` so its JwtStrategy can resolve them; re-exported so the use
// cases below inject the same providers without re-registering them.
const authLibProviders = [
  StaffUserTypeormRepository,
  { provide: STAFF_USER_REPOSITORY, useExisting: StaffUserTypeormRepository },
  ValidateStaffUserUseCase,
  { provide: AUTH_USER_VALIDATOR, useExisting: ValidateStaffUserUseCase },
];

@Module({
  imports: [
    TypeOrmModule.forFeature([StaffUserEntity, RoleEntity, PermissionEntity]),
    AuthLibModule.forRootAsync({
      imports: [TypeOrmModule.forFeature([StaffUserEntity])],
      providers: authLibProviders,
      exports: [STAFF_USER_REPOSITORY, AUTH_USER_VALIDATOR, ValidateStaffUserUseCase],
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
    RegisterStaffUserUseCase,
  ],
  exports: [
    PASSWORD_HASHER,
    TOKEN_SERVICE,
    RegisterStaffUserUseCase,
    ROLE_REPOSITORY,
    PERMISSION_REPOSITORY,
  ],
})
export class AuthModule {}
