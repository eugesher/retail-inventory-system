import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule as AuthLibModule, AUTH_USER_VALIDATOR } from '@retail-inventory-system/auth';
import { AUDIT_LOG_PUBLISHER } from '@retail-inventory-system/contracts';

import { CUSTOMER_REPOSITORY } from '../application/ports/customer.repository.port';
import { PASSWORD_HASHER } from '../application/ports/password.port';
import { PERMISSION_REPOSITORY } from '../application/ports/permission.repository.port';
import { ROLE_REPOSITORY } from '../application/ports/role.repository.port';
import { STAFF_USER_REPOSITORY } from '../application/ports/staff-user.repository.port';
import { TOKEN_SERVICE } from '../application/ports/token.port';
import { GetCurrentCustomerUseCase } from '../application/use-cases/get-current-customer.use-case';
import { LoginCustomerUseCase } from '../application/use-cases/login-customer.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { LogoutUseCase } from '../application/use-cases/logout.use-case';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.use-case';
import { RegisterCustomerUseCase } from '../application/use-cases/register-customer.use-case';
import { RegisterStaffUserUseCase } from '../application/use-cases/register-staff-user.use-case';
import { ValidateJwtSubjectUseCase } from '../application/use-cases/validate-jwt-subject.use-case';
import { AuthAdminController } from '../presentation/auth-admin.controller';
import { AuthController } from '../presentation/auth.controller';
import { CustomerAuthController } from '../presentation/customer-auth.controller';
import { StaffLoginController } from '../presentation/staff-login.controller';
import { Argon2PasswordAdapter } from './argon2/argon2-password.adapter';
import { NoOpAuditLogPublisher } from './audit/no-op-audit-log.publisher';
import { JwtTokenAdapter } from './jwt/jwt-token.adapter';
import { CustomerEntity } from './persistence/customer.entity';
import { CustomerTypeormRepository } from './persistence/customer-typeorm.repository';
import { PermissionEntity } from './persistence/permission.entity';
import { PermissionTypeormRepository } from './persistence/permission-typeorm.repository';
import { RoleEntity } from './persistence/role.entity';
import { RoleTypeormRepository } from './persistence/role-typeorm.repository';
import { StaffUserEntity } from './persistence/staff-user.entity';
import { StaffUserTypeormRepository } from './persistence/staff-user-typeorm.repository';

// AUTH_USER_VALIDATOR + STAFF_USER_REPOSITORY + CUSTOMER_REPOSITORY are bound
// inside libs/auth's `forRootAsync` so its JwtStrategy can resolve them; the
// validator now spans both subject kinds (task-05). Capturing the
// DynamicModule reference (rather than inlining the call) lets AuthModule
// *re-export* the whole dynamic module so its exports — STAFF_USER_REPOSITORY
// in particular — propagate to AuthModule's downstream consumers (today: IAM).
// NestJS does not permit re-exporting an individual token from an imported
// dynamic module via the outer module's `exports` array; the workaround is
// to re-export the module itself, which is what this constant enables.
const authLibProviders = [
  StaffUserTypeormRepository,
  { provide: STAFF_USER_REPOSITORY, useExisting: StaffUserTypeormRepository },
  CustomerTypeormRepository,
  { provide: CUSTOMER_REPOSITORY, useExisting: CustomerTypeormRepository },
  ValidateJwtSubjectUseCase,
  { provide: AUTH_USER_VALIDATOR, useExisting: ValidateJwtSubjectUseCase },
];

const authLibDynamicModule: DynamicModule = AuthLibModule.forRootAsync({
  imports: [TypeOrmModule.forFeature([StaffUserEntity, CustomerEntity])],
  providers: authLibProviders,
  exports: [
    STAFF_USER_REPOSITORY,
    CUSTOMER_REPOSITORY,
    AUTH_USER_VALIDATOR,
    ValidateJwtSubjectUseCase,
  ],
});

@Module({
  imports: [
    TypeOrmModule.forFeature([StaffUserEntity, RoleEntity, PermissionEntity, CustomerEntity]),
    authLibDynamicModule,
  ],
  controllers: [AuthController, AuthAdminController, CustomerAuthController, StaffLoginController],
  providers: [
    Argon2PasswordAdapter,
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordAdapter },

    JwtTokenAdapter,
    { provide: TOKEN_SERVICE, useExisting: JwtTokenAdapter },

    NoOpAuditLogPublisher,
    { provide: AUDIT_LOG_PUBLISHER, useExisting: NoOpAuditLogPublisher },

    RoleTypeormRepository,
    { provide: ROLE_REPOSITORY, useExisting: RoleTypeormRepository },

    PermissionTypeormRepository,
    { provide: PERMISSION_REPOSITORY, useExisting: PermissionTypeormRepository },

    LoginUseCase,
    LogoutUseCase,
    RefreshTokenUseCase,
    RegisterStaffUserUseCase,
    RegisterCustomerUseCase,
    LoginCustomerUseCase,
    GetCurrentCustomerUseCase,
  ],
  exports: [
    PASSWORD_HASHER,
    TOKEN_SERVICE,
    AUDIT_LOG_PUBLISHER,
    RegisterStaffUserUseCase,
    RegisterCustomerUseCase,
    ROLE_REPOSITORY,
    PERMISSION_REPOSITORY,
    // Re-export the dynamic AuthLibModule so STAFF_USER_REPOSITORY (and the
    // other AuthLib-bound tokens) are visible to AuthModule's consumers.
    // See the comment above `authLibDynamicModule` for why this is needed.
    authLibDynamicModule,
  ],
})
export class AuthModule {}
