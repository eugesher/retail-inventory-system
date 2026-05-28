import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

export interface ICreateRoleCommand {
  name: string;
  description?: string | null;
  permissionCodes: PermissionCodeEnum[];
}
