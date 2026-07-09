// Result of `inventory.reservation.sweep` — and the return type of the sweep use
// case itself, so the timer and the RPC observe one shape. `scanned - expired -
// skipped` is always `0`: every candidate the scan returned was either expired by
// this invocation or declined because a concurrent writer had already settled or
// refreshed it. That identity is how an operator reads the response.
export interface IReservationSweepResult {
  scanned: number; // candidate rows the scan returned
  expired: number; // holds actually flipped to `expired`
  skipped: number; // candidates a concurrent writer had already settled or refreshed
  durationMs: number;
}
