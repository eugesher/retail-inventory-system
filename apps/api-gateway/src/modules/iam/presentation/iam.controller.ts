import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser, RequiresPermission } from '@retail-inventory-system/auth';
import { ICurrentUser, PermissionCodeEnum } from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { RegisterStaffUserUseCase, RoleAggregate } from '../../auth';
import {
  AssignStaffRoleUseCase,
  CreateRoleUseCase,
  ListRolesUseCase,
  RevokeStaffRoleUseCase,
  UpdateRoleUseCase,
} from '../application/use-cases';
import {
  AssignStaffRoleRequestDto,
  CreateRoleRequestDto,
  CreateStaffUserRequestDto,
  RoleResponseDto,
  StaffRolesResponseDto,
  UpdateRoleRequestDto,
} from './dto';

@ApiTags('IAM')
@ApiBearerAuth()
@Controller('iam')
export class IamController {
  constructor(
    private readonly listRoles: ListRolesUseCase,
    private readonly createRole: CreateRoleUseCase,
    private readonly updateRole: UpdateRoleUseCase,
    private readonly assignStaffRole: AssignStaffRoleUseCase,
    private readonly revokeStaffRole: RevokeStaffRoleUseCase,
    // Owned by `modules/auth/` and reached through its barrel — the sanctioned cross-module
    // seam the admin shells use (ARCH-LINT-EX-02, ADR-024). The staff aggregate stays in the
    // module that owns it; IAM is the admin surface over it.
    private readonly registerStaffUser: RegisterStaffUserUseCase,
  ) {}

  @Get('roles')
  @RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
  @ApiOperation({ summary: 'List all roles' })
  @ApiOkResponse({ type: RoleResponseDto, isArray: true })
  public async list(): Promise<RoleResponseDto[]> {
    const roles = await this.listRoles.execute();
    return roles.map((r) => this.toDto(r));
  }

  @Post('roles')
  @RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
  @ApiOperation({ summary: 'Create a new role' })
  @ApiCreatedResponse({ type: RoleResponseDto })
  @ApiConflictResponse({ description: 'A role with that name already exists' })
  @ApiBadRequestResponse({ description: 'Unknown permission codes' })
  public async create(
    @Body() dto: CreateRoleRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<RoleResponseDto> {
    const role = await this.createRole.execute({
      name: dto.name,
      description: dto.description ?? null,
      permissionCodes: dto.permissionCodes,
      actorId: actor.id,
      correlationId,
    });
    return this.toDto(role);
  }

  @Patch('roles/:id')
  @RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
  @ApiOperation({ summary: 'Patch description and/or replace the permission set on a role' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({ description: 'No-op patch or unknown permission codes' })
  @ApiNotFoundResponse({ description: 'Role not found' })
  public async update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<RoleResponseDto> {
    const role = await this.updateRole.execute({
      id,
      description: dto.description,
      permissionCodes: dto.permissionCodes,
      actorId: actor.id,
      correlationId,
    });
    return this.toDto(role);
  }

  // Creating a staff user was the one thing this admin surface could not do: until now the
  // only way to mint a principal was the seed script. `RegisterStaffUserUseCase` had been
  // written, unit-tested and provided all along — it simply had no route (ADR-047).
  //
  // Gated on `iam:staff-create`, NOT `iam:assign`: minting a principal is a higher privilege
  // than granting an existing one a role bundle, and sharing a code would make role assignment
  // a silent user-creation escalation.
  @Post('staff')
  @RequiresPermission(PermissionCodeEnum.IAM_STAFF_CREATE)
  @ApiOperation({ summary: 'Create a staff user with one or more roles' })
  @ApiCreatedResponse({ type: StaffRolesResponseDto })
  @ApiBadRequestResponse({ description: 'Unknown role names, or no role given' })
  @ApiConflictResponse({ description: 'A staff user with that email already exists' })
  public async createStaff(
    @Body() dto: CreateStaffUserRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<StaffRolesResponseDto> {
    const staffUser = await this.registerStaffUser.execute({
      email: dto.email,
      password: dto.password,
      roleNames: dto.roleNames,
      actorId: actor.id,
      correlationId,
    });
    return {
      id: staffUser.id,
      email: staffUser.email,
      roleNames: staffUser.roles.map((r) => r.name),
    };
  }

  @Post('staff/:id/roles')
  @RequiresPermission(PermissionCodeEnum.IAM_ASSIGN)
  @ApiOperation({ summary: 'Assign one or more roles to a staff user (idempotent)' })
  @ApiOkResponse({ type: StaffRolesResponseDto })
  @ApiBadRequestResponse({ description: 'Unknown role names' })
  @ApiNotFoundResponse({ description: 'StaffUser not found or suspended' })
  @HttpCode(HttpStatus.OK)
  public async assign(
    @Param('id') id: string,
    @Body() dto: AssignStaffRoleRequestDto,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<StaffRolesResponseDto> {
    const staffUser = await this.assignStaffRole.execute({
      staffUserId: id,
      roleNames: dto.roleNames,
      actorId: actor.id,
      correlationId,
    });
    return {
      id: staffUser.id,
      email: staffUser.email,
      roleNames: staffUser.roles.map((r) => r.name),
    };
  }

  @Delete('staff/:id/roles/:roleName')
  @RequiresPermission(PermissionCodeEnum.IAM_ASSIGN)
  @ApiOperation({ summary: 'Revoke a role from a staff user' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'StaffUser not found or role not bound to user' })
  @ApiConflictResponse({ description: 'Cannot revoke the last remaining role' })
  @HttpCode(HttpStatus.NO_CONTENT)
  public async revoke(
    @Param('id') id: string,
    @Param('roleName') roleName: string,
    @CurrentUser() actor: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    await this.revokeStaffRole.execute({
      staffUserId: id,
      roleName,
      actorId: actor.id,
      correlationId,
    });
  }

  private toDto(role: RoleAggregate): RoleResponseDto {
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      permissionCodes: Array.from(role.permissions),
    };
  }
}
