// Canonical permission code registry. Values match the regex
// `^[a-z][a-z-]*:[a-z][a-z-]*$` and are seeded into the `permission`
// table by `scripts/test-db-seed.ts`; the four seeded roles each bind
// a subset of these codes via `role_permissions`.
export enum PermissionCodeEnum {
  CATALOG_READ = 'catalog:read',
  CATALOG_WRITE = 'catalog:write',
  CATALOG_PUBLISH = 'catalog:publish',
  INVENTORY_READ = 'inventory:read',
  INVENTORY_ADJUST = 'inventory:adjust',
  INVENTORY_TRANSFER = 'inventory:transfer',
  ORDER_READ = 'order:read',
  ORDER_CAPTURE = 'order:capture',
  ORDER_FULFILL = 'order:fulfill',
  ORDER_CANCEL = 'order:cancel',
  ORDER_REFUND = 'order:refund',
  IAM_ASSIGN = 'iam:assign',
  IAM_ROLE_EDIT = 'iam:role-edit',
  AUDIT_READ = 'audit:read',
  PRICING_WRITE = 'pricing:write',
}
