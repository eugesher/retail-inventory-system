import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.price.set` (API Gateway → Catalog).
// One command backs both **Set** (immediate) and **Schedule** (future) — they
// differ only by `validFrom`: omit it for an immediate price (the domain
// defaults it to "now"), or supply a future ISO instant to schedule one. A
// `validFrom` strictly before now is rejected by the domain
// (`PRICE_VALID_FROM_IN_PAST`).
//
// `amountMinor` is an integer count of minor units (cents), never a float —
// money is integer arithmetic. `currency` is the ISO-4217 3-char code (shape
// validated only). `validTo` is the optional close instant; `null`/omitted means
// open-ended. `priority` breaks ties at resolution time (default `0`). All
// timestamps cross the wire as ISO-8601 strings.
export interface IPriceSetPayload extends ICorrelationPayload {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom?: string;
  validTo?: string | null;
  priority?: number;
}
