export class ReturnWriteConflictError extends Error {
  constructor(
    public readonly rmaId: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Optimistic write conflict on return request ${rmaId} (current version ${currentVersion})`,
    );
    this.name = 'ReturnWriteConflictError';
  }
}
