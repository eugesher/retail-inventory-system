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
  INVENTORY_RECEIVE_RETURN = 'inventory:receive-return',
  ORDER_READ = 'order:read',
  ORDER_CAPTURE = 'order:capture',
  ORDER_FULFILL = 'order:fulfill',
  ORDER_CANCEL = 'order:cancel',
  ORDER_REFUND = 'order:refund',
  ORDER_RETURN_AUTHORIZE = 'order:return-authorize',
  NOTIFICATIONS_READ = 'notifications:read',
  NOTIFICATIONS_WRITE = 'notifications:write',
  IAM_ASSIGN = 'iam:assign',
  IAM_ROLE_EDIT = 'iam:role-edit',
  AUDIT_READ = 'audit:read',
  PRICING_WRITE = 'pricing:write',
  // Customer-privacy staff overrides (admin-only). There is deliberately NO
  // customer-facing consent permission code: a customer JWT carries no
  // `permissions` claim (ADR-024/028), so a `@RequiresPermission('customer:…')`
  // gate would be unreachable-by-construction dead code — the customer consent
  // write path is authorized by authentication + inherent ownership, and these
  // two codes gate only the staff read/erase overrides.
  CUSTOMER_READ_CONSENT = 'customer:read-consent',
  CUSTOMER_ERASE = 'customer:erase',
}
