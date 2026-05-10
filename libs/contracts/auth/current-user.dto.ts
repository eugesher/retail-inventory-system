import { RoleEnum } from './role.enum';

export interface ICurrentUser {
  id: string;
  email: string;
  roles: RoleEnum[];
}
