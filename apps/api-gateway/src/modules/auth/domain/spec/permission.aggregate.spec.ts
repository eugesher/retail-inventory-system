import { PermissionAggregate } from '../permission.aggregate';

describe('PermissionAggregate', () => {
  const id = '22222222-2222-4222-a222-222222222222';

  describe('code invariant', () => {
    const valid = [
      'catalog:read',
      'catalog:write',
      'inventory:adjust',
      'order:cancel',
      'iam:role-edit',
      'audit:read',
    ];
    const invalid = ['', 'Catalog:Read', 'catalog:', ':read', 'catalog read', 'catalog::read'];

    it.each(valid)('accepts %p', (code) => {
      expect(() => PermissionAggregate.create(id, { code })).not.toThrow();
    });

    it.each(invalid)('rejects %p', (code) => {
      expect(() => PermissionAggregate.create(id, { code })).toThrow(/code must match/);
    });
  });

  it('exposes the code and optional description', () => {
    const perm = PermissionAggregate.create(id, {
      code: 'catalog:write',
      description: 'create or update catalog items',
    });

    expect(perm.code).toBe('catalog:write');
    expect(perm.description).toBe('create or update catalog items');
  });

  it('rehydrate returns an aggregate with the same identity', () => {
    const perm = PermissionAggregate.rehydrate(id, { code: 'audit:read' });
    expect(perm.id).toBe(id);
  });
});
