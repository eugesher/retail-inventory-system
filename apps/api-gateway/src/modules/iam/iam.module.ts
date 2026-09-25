import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import {
  AssignStaffRoleUseCase,
  CreateRoleUseCase,
  ListRolesUseCase,
  RevokeStaffRoleUseCase,
  UpdateRoleUseCase,
} from './application/use-cases';
import { IamController } from './presentation';

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
