import { RoleEnum } from '@retail-inventory-system/contracts';

export interface ICurrentUserView {
  id: string;
  email: string;
  roles: RoleEnum[];
}
