export class CartWriteConflictError extends Error {
  constructor(
    public readonly cartId: string,
    public readonly currentVersion: number,
  ) {
    super(`Optimistic write conflict on cart ${cartId} (current version ${currentVersion})`);
    this.name = 'CartWriteConflictError';
  }
}
