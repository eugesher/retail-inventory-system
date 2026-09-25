import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';

import { Customer, StaffUser } from '../../domain';
import { ICustomerRepositoryPort, IStaffUserRepositoryPort } from '../ports';

export interface IResolvedAuthSubject {
  subject: StaffUser | Customer;
  roles: RoleEnum[];
  permissions: PermissionCodeEnum[];
  actorKind: 'staff' | 'customer';
  targetKind: 'staff-user' | 'customer';
  persist(): Promise<void>;
}

export async function resolveAuthSubject(
  staff: IStaffUserRepositoryPort,
  customers: ICustomerRepositoryPort,
  id: string,
): Promise<IResolvedAuthSubject | null> {
  const staffUser = await staff.findById(id);
  if (staffUser) {
    return {
      subject: staffUser,
      roles: staffUser.roleNames as RoleEnum[],
      permissions: staffUser.permissionCodes,
      actorKind: 'staff',
      targetKind: 'staff-user',
      persist: async (): Promise<void> => {
        await staff.save(staffUser);
      },
    };
  }

  const customer = await customers.findById(id);
  if (customer) {
    return {
      subject: customer,
      roles: [],
      permissions: [],
      actorKind: 'customer',
      targetKind: 'customer',
      persist: async (): Promise<void> => {
        await customers.save(customer);
      },
    };
  }

  return null;
}
