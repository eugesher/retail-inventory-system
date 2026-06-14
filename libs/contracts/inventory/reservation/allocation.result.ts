// One allocated line in an `inventory.reservation.allocate` result: the variant,
// the resolved location (always concrete — the default was applied at the edge),
// the allocated quantity, and the hold that was committed — or **null** on the
// direct-allocation fallback (no prior reservation, ADR-030 §4).
export interface IAllocationResultEntry {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  reservationId: string | null;
}

// Result of `inventory.reservation.allocate`: the lines that were allocated this
// call, in request order. Because allocate is all-lines-atomic, this is either the
// full set (the whole order allocated) or the call rejected and nothing committed.
export interface IAllocationResult {
  allocated: IAllocationResultEntry[];
}
