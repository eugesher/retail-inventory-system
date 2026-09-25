import { BadRequestException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { IPermissionRepositoryPort } from '../../../auth';

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
