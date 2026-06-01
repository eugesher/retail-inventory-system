import { BadRequestException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { IPermissionRepositoryPort } from '../../../auth';

// Shared by every role-mutation use case that accepts permission codes: the
// "all of these codes resolve to a real permission" rule is one fact about the
// permission registry, so it lives in one place rather than being copied into
// CreateRole/UpdateRole (and any future code-accepting use case).
export async function assertPermissionsExist(
  permissions: IPermissionRepositoryPort,
  codes: PermissionCodeEnum[],
): Promise<void> {
  if (codes.length === 0) return;
  const found = await permissions.findByCodes(codes);
  const foundSet = new Set(found.map((p) => p.code));
  const missing = codes.filter((c) => !foundSet.has(c));
  if (missing.length > 0) {
    throw new BadRequestException(`Unknown permission codes: ${missing.join(', ')}`);
  }
}
