import { ICorrelationPayload } from '../../microservices';

// RPC payload for `inventory.reservation.sweep` (Gateway → Inventory). Triggers one
// immediate invocation of the same sweep the scheduled tick runs.
export interface IReservationSweepPayload extends ICorrelationPayload {
  // Optional override, clamped by the service into [1, RESERVATION_SWEEP_BATCH_SIZE].
  // The configured value is a ceiling, not a default an operator can raise.
  batchSize?: number;
  // The staff principal who triggered it; recorded on every `release` ledger row this
  // invocation writes. A scheduled tick passes null.
  actorId?: string | null;
}
