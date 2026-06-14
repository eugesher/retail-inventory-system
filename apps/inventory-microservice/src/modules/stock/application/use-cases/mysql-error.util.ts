// MySQL's "duplicate entry for key" error number / code. A first-touch INSERT that
// loses a UNIQUE-constraint race (a stock-level `(variant_id, stock_location_id)`
// pair, a reservation's all-statuses triple, or an auto-init level) surfaces a
// driver error carrying these. Duck-typed (not `instanceof QueryFailedError`)
// because the application layer must not import `typeorm` (ADR-017 denylist), and
// the repositories duck-type the same shape — the wire shape is the only contract.
const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

interface IMysqlDriverError {
  errno?: number;
  code?: string;
  driverError?: { errno?: number; code?: string };
}

// The single duplicate-key predicate shared by the auto-init use case and the
// stock-level / reservation repositories (it was copy-pasted in all three before).
// The driver may nest the real error under `driverError`, so check both levels.
export function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as IMysqlDriverError;
  const driver = candidate.driverError ?? candidate;
  return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
}
