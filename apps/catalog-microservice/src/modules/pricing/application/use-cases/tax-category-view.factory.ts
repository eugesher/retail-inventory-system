import { TaxCategoryView } from '@retail-inventory-system/contracts';

import { TaxCategory } from '../../domain';

export const toTaxCategoryView = (taxCategory: TaxCategory): TaxCategoryView => ({
  id: taxCategory.id!,
  code: taxCategory.code,
  name: taxCategory.name,
  description: taxCategory.description,
});
