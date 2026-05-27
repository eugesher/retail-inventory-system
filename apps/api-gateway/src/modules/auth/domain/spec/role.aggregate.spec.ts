import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../role.aggregate';

describe('RoleAggregate', () => {
  const id = '11111111-1111-4111-a111-111111111111';

  describe('name invariant', () => {
    const valid = ['admin', 'catalog-manager', 'warehouse-staff', 'order-support', 'role1'];
    const invalid = ['', 'Admin', 'CATALOG', '1role', '-role', 'catalog_manager', 'role!'];

    it.each(valid)('accepts %p', (name) => {
      expect(() => RoleAggregate.create(id, { name })).not.toThrow();
    });

    it.each(invalid)('rejects %p', (name) => {
      expect(() => RoleAggregate.create(id, { name })).toThrow(/name must match/);
    });
  });

  describe('permissions set semantics', () => {
    it('stores permissions as a Set — duplicate addPermission is a no-op', () => {
      const role = RoleAggregate.create(id, { name: 'admin' });
      role.addPermission(PermissionCodeEnum.CATALOG_READ);
      role.addPermission(PermissionCodeEnum.CATALOG_READ);

      expect(role.permissions.size).toBe(1);
      expect(role.hasPermission(PermissionCodeEnum.CATALOG_READ)).toBe(true);
    });

    it('seeds permissions from the constructor argument', () => {
      const role = RoleAggregate.create(id, {
        name: 'catalog-manager',
        permissions: [PermissionCodeEnum.CATALOG_READ, PermissionCodeEnum.CATALOG_WRITE],
      });

      expect(role.permissions.size).toBe(2);
      expect(role.hasPermission(PermissionCodeEnum.CATALOG_WRITE)).toBe(true);
    });

    it('removePermission drops a bound code; hasPermission returns false', () => {
      const role = RoleAggregate.create(id, {
        name: 'admin',
        permissions: [PermissionCodeEnum.ORDER_REFUND],
      });
      role.removePermission(PermissionCodeEnum.ORDER_REFUND);

      expect(role.permissions.size).toBe(0);
      expect(role.hasPermission(PermissionCodeEnum.ORDER_REFUND)).toBe(false);
    });

    it('hasPermission returns false for an unbound code', () => {
      const role = RoleAggregate.create(id, { name: 'order-support' });
      expect(role.hasPermission(PermissionCodeEnum.AUDIT_READ)).toBe(false);
    });
  });
});
