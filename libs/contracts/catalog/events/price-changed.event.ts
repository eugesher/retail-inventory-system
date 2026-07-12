import { ICorrelationPayload } from '../../microservices';

// `catalog.price.changed` — a **reserved surface** (README §2). Not dead code.
//
// Raised only for an **immediate** price: one whose `validFrom` is at or before now, so the new
// amount takes effect on append. A *scheduled* price raises `catalog.price.scheduled` instead —
// binding one of these keys does not get you the other.
//
// The payload carries the resulting open row's whole interval (`validFrom` / `validTo`, `null`
// meaning open-ended, plus the `priority` tiebreak) so a consumer never needs a read-back.
export interface ICatalogPriceChangedEvent extends ICorrelationPayload {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: string;
  validTo: string | null;
  priority: number;
  eventVersion: 'v1';
  occurredAt: string;
}
