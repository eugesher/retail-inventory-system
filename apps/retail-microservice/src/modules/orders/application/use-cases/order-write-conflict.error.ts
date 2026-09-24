export class OrderWriteConflictError extends Error {
  constructor(
    public readonly orderId: number,
    public readonly currentVersion: number,
  ) {
    super(`Optimistic write conflict on order ${orderId} (current version ${currentVersion})`);
    this.name = 'OrderWriteConflictError';
  }
}
