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
