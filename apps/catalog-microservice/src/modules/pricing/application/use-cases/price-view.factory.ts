import { PriceView } from '@retail-inventory-system/contracts';

import { Price } from '../../domain';

export const toPriceView = (price: Price): PriceView => ({
  id: price.id!,
  variantId: price.variantId,
  currency: price.currency,
  amountMinor: price.amountMinor,
  validFrom: price.validFrom.toISOString(),
  validTo: price.validTo === null ? null : price.validTo.toISOString(),
  priority: price.priority,
});
