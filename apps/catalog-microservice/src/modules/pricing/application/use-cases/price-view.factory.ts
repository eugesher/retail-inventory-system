import { PriceView } from '@retail-inventory-system/contracts';

import { Price } from '../../domain';

// Pure mapping from a domain `Price` onto the `PriceView` wire shape, shared by
// the set / list / select use cases so the projection lives in exactly one place
// (mirrors the catalog `catalog-view.factory.ts`). Framework-free (no Nest
// decorators). Dates become ISO-8601 strings — the wire is JSON; `validTo` stays
// `null` for an open-ended row. `id` is non-null here because every `Price` that
// reaches a view has been through the repository (which assigns the concrete id).
export const toPriceView = (price: Price): PriceView => ({
  id: price.id!,
  variantId: price.variantId,
  currency: price.currency,
  amountMinor: price.amountMinor,
  validFrom: price.validFrom.toISOString(),
  validTo: price.validTo === null ? null : price.validTo.toISOString(),
  priority: price.priority,
});
