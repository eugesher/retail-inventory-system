import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

export interface IUpdateRoleCommand {
  id: string;
  description?: string | null;
  permissionCodes?: PermissionCodeEnum[];
  actorId?: string | null;
  correlationId?: string | null;
}
