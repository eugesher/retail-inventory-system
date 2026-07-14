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

// AUTH_USER_VALIDATOR + STAFF_USER_REPOSITORY + CUSTOMER_REPOSITORY are bound
// inside libs/auth's `forRootAsync` so its JwtStrategy can resolve them; the
// validator now spans both subject kinds (staff and customer). Capturing the
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
  // Both of these are LOAD-BEARING, for different reasons — and the difference is worth stating,
  // because it is not visible from the file layout:
  //
  //   `STAFF_USER_REPOSITORY` leaves the app entirely: re-exporting the dynamic module is what
  //   propagates it to AuthModule's downstream consumers (today: IAM).
  //
  //   `CUSTOMER_REPOSITORY` never leaves AuthModule — but its PROVIDER lives here, inside the
  //   dynamic AuthLibModule, while its eight consumers (Login/Logout/Register/Refresh/Erase/…)
  //   are AuthModule's own use cases. Those are two different Nest modules despite sharing a
  //   directory, so without this export the whole gateway fails to boot.
  //
  // `AUTH_USER_VALIDATOR` and `ValidateJwtSubjectUseCase` used to ride along and are gone:
  // `libs/auth`'s `JwtStrategy` resolves the validator from `providers` above, inside the same
  // module, and nothing else consumed either.
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
    // The producer-side client for the `ris.events` topic exchange — the real
    // `AuditLogRabbitmqPublisher` injects its `RIS_EVENTS_PUBLISHER` `ClientProxy`
    // to emit `audit.staff.action` (ADR-035).
    MicroserviceClientRisEventsModule,
    // The `notification_events` producer client — `CustomerEventsRabbitmqPublisher`
    // injects its `NOTIFICATION_MICROSERVICE` `ClientProxy` to emit the two
    // `customer.*` privacy events onto the notification consumers' queue (ADR-037).
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

    // The audit seam (ADR-035): the real RMQ adapter publishes `audit.staff.action`
    // onto `ris.events`. `iam` consumes `AUDIT_LOG_PUBLISHER` through this module's
    // export (there is no second binding in `iam`).
    AuditLogRabbitmqPublisher,
    { provide: AUDIT_LOG_PUBLISHER, useExisting: AuditLogRabbitmqPublisher },

    RoleTypeormRepository,
    { provide: ROLE_REPOSITORY, useExisting: RoleTypeormRepository },

    PermissionTypeormRepository,
    { provide: PERMISSION_REPOSITORY, useExisting: PermissionTypeormRepository },

    // The customer channel-consent store. Bound here + exported so the consent
    // Record/Read use cases resolve it.
    ConsentRecordTypeormRepository,
    { provide: CONSENT_RECORD_REPOSITORY, useExisting: ConsentRecordTypeormRepository },

    // The customer-privacy event publisher (ADR-037): emits `customer.consent.updated`
    // / `customer.erased` onto `notification_events` and mirrors onto `ris.events`.
    CustomerEventsRabbitmqPublisher,
    { provide: CUSTOMER_EVENTS_PUBLISHER, useExisting: CustomerEventsRabbitmqPublisher },

    // The cross-context erasure writer (ADR-037 §3): nulls the customer + address
    // + cart PII in one transaction over the shared `retail_db` via raw SQL. It
    // injects the default `EntityManager` (no `forFeature` — the root connection is
    // global), so no extra TypeORM registration is needed.
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
    // Exported so the `customer-admin` controller can reuse the owner-or-staff Read
    // Consent use case unchanged (passing `isStaff: true`) and drive the tombstone
    // erase. The domain mutation stays in the module that owns the `Customer`
    // aggregate (ADR-004); `customer-admin` is a thin admin shell (ADR-024).
    ReadConsentUseCase,
    EraseCustomerUseCase,
    // Re-export the dynamic AuthLibModule so STAFF_USER_REPOSITORY (and the
    // other AuthLib-bound tokens) are visible to AuthModule's consumers.
    // See the comment above `authLibDynamicModule` for why this is needed.
    authLibDynamicModule,
  ],
})
export class AuthModule {}
