export class LedgerReplayError extends Error {
  constructor(
    public readonly referenceType: string,
    public readonly referenceId: string,
  ) {
    super(`Ledger already holds ${referenceType} ${referenceId} — this delivery is a replay`);
    this.name = 'LedgerReplayError';
  }
}
