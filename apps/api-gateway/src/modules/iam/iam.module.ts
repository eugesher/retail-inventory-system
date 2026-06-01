import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import {
  AssignStaffRoleUseCase,
  CreateRoleUseCase,
  ListRolesUseCase,
  RevokeStaffRoleUseCase,
  UpdateRoleUseCase,
} from './application/use-cases';
import { IamController } from './presentation/iam.controller';

// IAM is a presentation-and-orchestration shell over the auth module's
// Role / Permission / StaffUser aggregates (no own `domain/` folder, see
// ADR-024). Re-uses auth's repository adapters via the ROLE_REPOSITORY /
// PERMISSION_REPOSITORY / STAFF_USER_REPOSITORY tokens that AuthModule
// re-exports. Adding the repositories here would duplicate the providers
// and break the singleton that the JWT strategy already holds.
@Module({
  imports: [AuthModule],
  controllers: [IamController],
  providers: [
    ListRolesUseCase,
    CreateRoleUseCase,
    UpdateRoleUseCase,
    AssignStaffRoleUseCase,
    RevokeStaffRoleUseCase,
  ],
})
export class IamModule {}
