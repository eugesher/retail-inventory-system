import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule as AuthLibModule, AUTH_USER_VALIDATOR } from '@retail-inventory-system/auth';
import { AUDIT_LOG_PUBLISHER } from '@retail-inventory-system/contracts';
import {
  MicroserviceClientNotificationModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  CONSENT_RECORD_REPOSITORY,
  CUSTOMER_ERASURE_WRITER,
  CUSTOMER_EVENTS_PUBLISHER,
  CUSTOMER_REPOSITORY,
  PASSWORD_HASHER,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  STAFF_USER_REPOSITORY,
  TOKEN_SERVICE,
} from './application/ports';
import {
  CreateGuestSessionUseCase,
  EraseCustomerUseCase,
  GetCurrentCustomerUseCase,
  LoginCustomerUseCase,
  LoginUseCase,
  LogoutUseCase,
  ReadConsentUseCase,
  RecordConsentUseCase,
  RefreshTokenUseCase,
  RegisterCustomerUseCase,
  RegisterStaffUserUseCase,
  ValidateJwtSubjectUseCase,
} from './application/use-cases';
import { Argon2PasswordAdapter } from './infrastructure/argon2';
import { AuditLogRabbitmqPublisher } from './infrastructure/audit';
import { JwtTokenAdapter } from './infrastructure/jwt';
import { CustomerEventsRabbitmqPublisher } from './infrastructure/messaging';
import {
  ConsentRecordEntity,
  ConsentRecordTypeormRepository,
  CustomerEntity,
  CustomerErasureWriterAdapter,
  CustomerTypeormRepository,
  PermissionEntity,
  PermissionTypeormRepository,
  RoleEntity,
  RoleTypeormRepository,
  StaffUserEntity,
  StaffUserTypeormRepository,
} from './infrastructure/persistence';
import {
  AuthAdminController,
  AuthController,
  CustomerAuthController,
  CustomerConsentController,
  StaffLoginController,
} from './presentation';

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
  exports: [STAFF_USER_REPOSITORY, CUSTOMER_REPOSITORY],
});

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StaffUserEntity,
      RoleEntity,
      PermissionEntity,
      CustomerEntity,
      ConsentRecordEntity,
    ]),
    authLibDynamicModule,
    MicroserviceClientRisEventsModule,
    MicroserviceClientNotificationModule,
  ],
  controllers: [
    AuthController,
    AuthAdminController,
    CustomerAuthController,
    CustomerConsentController,
    StaffLoginController,
  ],
  providers: [
    Argon2PasswordAdapter,
    { provide: PASSWORD_HASHER, useExisting: Argon2PasswordAdapter },

    JwtTokenAdapter,
    { provide: TOKEN_SERVICE, useExisting: JwtTokenAdapter },

    AuditLogRabbitmqPublisher,
    { provide: AUDIT_LOG_PUBLISHER, useExisting: AuditLogRabbitmqPublisher },

    RoleTypeormRepository,
    { provide: ROLE_REPOSITORY, useExisting: RoleTypeormRepository },

    PermissionTypeormRepository,
    { provide: PERMISSION_REPOSITORY, useExisting: PermissionTypeormRepository },

    ConsentRecordTypeormRepository,
    { provide: CONSENT_RECORD_REPOSITORY, useExisting: ConsentRecordTypeormRepository },

    CustomerEventsRabbitmqPublisher,
    { provide: CUSTOMER_EVENTS_PUBLISHER, useExisting: CustomerEventsRabbitmqPublisher },

    CustomerErasureWriterAdapter,
    { provide: CUSTOMER_ERASURE_WRITER, useExisting: CustomerErasureWriterAdapter },

    LoginUseCase,
    LogoutUseCase,
    RefreshTokenUseCase,
    RegisterStaffUserUseCase,
    RegisterCustomerUseCase,
    LoginCustomerUseCase,
    CreateGuestSessionUseCase,
    GetCurrentCustomerUseCase,
    RecordConsentUseCase,
    ReadConsentUseCase,
    EraseCustomerUseCase,
  ],
  exports: [
    PASSWORD_HASHER,
    TOKEN_SERVICE,
    AUDIT_LOG_PUBLISHER,
    RegisterStaffUserUseCase,
    RegisterCustomerUseCase,
    ROLE_REPOSITORY,
    PERMISSION_REPOSITORY,
    CONSENT_RECORD_REPOSITORY,
    ReadConsentUseCase,
    EraseCustomerUseCase,
    authLibDynamicModule,
  ],
})
export class AuthModule {}
