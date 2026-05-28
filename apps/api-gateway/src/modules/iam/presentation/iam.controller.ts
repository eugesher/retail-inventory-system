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

import { AssignStaffRoleUseCase } from '../application/use-cases/assign-staff-role.use-case';
import { CreateRoleUseCase } from '../application/use-cases/create-role.use-case';
import { ListRolesUseCase } from '../application/use-cases/list-roles.use-case';
import { RevokeStaffRoleUseCase } from '../application/use-cases/revoke-staff-role.use-case';
import { UpdateRoleUseCase } from '../application/use-cases/update-role.use-case';
import { AssignStaffRoleRequestDto } from './dto/assign-staff-role.request.dto';
import { CreateRoleRequestDto } from './dto/create-role.request.dto';
import { RoleResponseDto } from './dto/role.response.dto';
import { StaffRolesResponseDto } from './dto/staff-roles.response.dto';
import { UpdateRoleRequestDto } from './dto/update-role.request.dto';

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
  ) {}

  @Get('roles')
  @RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
  @ApiOperation({ summary: 'List all roles' })
  @ApiOkResponse({ type: RoleResponseDto, isArray: true })
  public async list(): Promise<RoleResponseDto[]> {
    const roles = await this.listRoles.execute();
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissionCodes: Array.from(r.permissions),
    }));
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
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      permissionCodes: Array.from(role.permissions),
    };
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
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      permissionCodes: Array.from(role.permissions),
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
}
