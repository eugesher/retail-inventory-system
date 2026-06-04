import { TaxCategoryView } from '@retail-inventory-system/contracts';

import { TaxCategory } from '../../domain';

// Pure mapping from a domain `TaxCategory` onto the `TaxCategoryView` wire shape,
// shared by the create / list use cases so the projection lives in exactly one
// place (mirrors `price-view.factory.ts`). Framework-free (no Nest decorators).
// `id` is non-null here because every `TaxCategory` that reaches a view has been
// through the repository, which assigns the concrete id.
export const toTaxCategoryView = (taxCategory: TaxCategory): TaxCategoryView => ({
  id: taxCategory.id!,
  code: taxCategory.code,
  name: taxCategory.name,
  description: taxCategory.description,
});
