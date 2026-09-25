const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

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
  return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
}
