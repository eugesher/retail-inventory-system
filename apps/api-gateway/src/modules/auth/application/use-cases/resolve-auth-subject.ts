import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';

import { Customer, StaffUser } from '../../domain';
import { ICustomerRepositoryPort, IStaffUserRepositoryPort } from '../ports';

// A bearer subject resolved across both identity spaces. The `sub` claim is not
// globally unique across the staff and customer id spaces, so callers resolve
// staff first and fall back to customer — mirroring ValidateJwtSubjectUseCase.
// The shared `/auth/refresh` and `/auth/logout` routes are reachable by either
// kind, so both must resolve the subject this way rather than against a single
// repository.
export interface IResolvedAuthSubject {
  subject: StaffUser | Customer;
  // JWT claim material — staff carry their inflated role/permission union;
  // customers always mint empty claims.
  roles: RoleEnum[];
  permissions: PermissionCodeEnum[];
  actorKind: 'staff' | 'customer';
  targetKind: 'staff-user' | 'customer';
  // Persists the resolved aggregate back to its own repository.
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
