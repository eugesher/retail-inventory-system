// MySQL's "duplicate entry for key" markers — duck-typed (not `instanceof
// QueryFailedError`) so the predicate matches whether the driver nests the real error
// under `driverError` or not. Shared by the two notification persistence adapters (the
// delivery-dedupe re-load and the template duplicate-version translation); it is a copy of
// the inventory `mysql-error.util` because that lives in another service's module and
// cross-service code never reaches across (the ADR-017 isolation boundary).
interface IMysqlDriverError {
  errno?: number;
  code?: string;
  driverError?: { errno?: number; code?: string };
}

export function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as IMysqlDriverError;
  const driver = candidate.driverError ?? candidate;
  return driver.errno === 1062 || driver.code === 'ER_DUP_ENTRY';
}
