// MySQL's "duplicate entry" error number and code. A first-touch INSERT that loses a UNIQUE race —
// a stock-level `(variant_id, stock_location_id)` pair, a reservation's all-statuses triple — comes
// back as a driver error carrying one of these.
//
// **Duck-typed, not `instanceof QueryFailedError`, and that is forced.** The application layer may
// not import `typeorm` (ADR-017), so the error's *shape* is the only contract available. The
// predicate therefore lives here, in `application/`, and the infrastructure repositories reach up
// to it — the one direction that stays legal.
const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

interface IMysqlDriverError {
  errno?: number;
  code?: string;
  driverError?: { errno?: number; code?: string };
}

// **The driver may nest the real error under `driverError`**, so both levels are checked. A
// predicate that only looked at the top level would silently return `false` for half the races it
// exists to catch, and the caller would translate a lost INSERT into a hard failure instead of a
// retry.
export function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as IMysqlDriverError;
  const driver = candidate.driverError ?? candidate;
  return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
}
