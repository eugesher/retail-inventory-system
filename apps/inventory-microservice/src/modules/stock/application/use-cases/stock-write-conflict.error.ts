export class StockWriteConflictError extends Error {
  constructor(
    public readonly variantId: number,
    public readonly stockLocationId: string,
    public readonly expectedVersion: number | null = null,
  ) {
    super(`Optimistic write conflict on stock level (variant ${variantId} @ ${stockLocationId})`);
    this.name = 'StockWriteConflictError';
  }
}
