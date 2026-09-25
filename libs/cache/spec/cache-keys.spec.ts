import { CACHE_KEYS } from '../cache-keys';

describe('CACHE_KEYS', () => {
  describe('inventoryStock (current convention — v3, keyed on variantId)', () => {
    it('embeds the v3 schema-version segment in the single-tenant prefix', () => {
      expect(CACHE_KEYS.inventoryStockPrefix(42)).toBe('ris:inventory:stock:v3:42:');
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:v3:42:__all__');
    });

    it('omits the tenant segment entirely when no tenantId is supplied', () => {
      expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/(^|:)t:/);
      expect(CACHE_KEYS.inventoryStockPrefix(42)).not.toMatch(/(^|:)t:/);
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      expect(CACHE_KEYS.inventoryStockPrefix(42, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:inventory:stock:v3:42:',
      );
      expect(CACHE_KEYS.inventoryStock(42, undefined, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:inventory:stock:v3:42:__all__',
      );
    });

    it('keeps the prefix and full key consistent so delByPrefix wipes every facet', () => {
      const variantId = 42;
      const tenantId = 'store-7';

      const singleTenantPrefix = CACHE_KEYS.inventoryStockPrefix(variantId);
      expect(CACHE_KEYS.inventoryStock(variantId).startsWith(singleTenantPrefix)).toBe(true);
      expect(
        CACHE_KEYS.inventoryStock(variantId, ['head-warehouse']).startsWith(singleTenantPrefix),
      ).toBe(true);

      const tenantPrefix = CACHE_KEYS.inventoryStockPrefix(variantId, { tenantId });
      expect(
        CACHE_KEYS.inventoryStock(variantId, undefined, { tenantId }).startsWith(tenantPrefix),
      ).toBe(true);
      expect(
        CACHE_KEYS.inventoryStock(variantId, ['head-warehouse'], { tenantId }).startsWith(
          tenantPrefix,
        ),
      ).toBe(true);
    });

    it('uses the __all__ sentinel (non-glob) when no stockLocationIds are provided', () => {
      expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/\*/);
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:v3:42:__all__');
    });

    it('uses the __all__ sentinel when stockLocationIds is an empty array', () => {
      expect(CACHE_KEYS.inventoryStock(42, [])).toBe('ris:inventory:stock:v3:42:__all__');
    });

    it('joins sorted stockLocationIds with localeCompare', () => {
      expect(CACHE_KEYS.inventoryStock(1, ['ab', 'aa'])).toBe('ris:inventory:stock:v3:1:aa,ab');
      expect(CACHE_KEYS.inventoryStock(1, ['aa', 'ab'])).toBe('ris:inventory:stock:v3:1:aa,ab');
    });

    it('does not mutate the caller-supplied array', () => {
      const input = ['west', 'east'];
      CACHE_KEYS.inventoryStock(1, input);
      expect(input).toEqual(['west', 'east']);
    });
  });

  describe('inventoryStockLegacyPrefixV2 (pre-v3 — RETIRED, no caller)', () => {
    it('still produces the retired v2 shape', () => {
      expect(CACHE_KEYS.inventoryStockLegacyPrefixV2(42)).toBe('ris:inventory:stock:v2:42:');
    });
  });

  describe('inventoryStockLegacyPrefixV1 (pre-v2 — RETIRED, no caller)', () => {
    it('still produces the retired v1 shape', () => {
      expect(CACHE_KEYS.inventoryStockLegacyPrefixV1(42)).toBe('ris:inventory:stock:v1:42:');
    });
  });

  describe('inventoryStockLegacyPrefix (pre-v1 — RETIRED, no caller)', () => {
    it('still produces the pre-v1 shape, without a version segment', () => {
      expect(CACHE_KEYS.inventoryStockLegacyPrefix(42)).toBe('ris:inventory:stock:42:');
    });
  });

  describe('retailOrder (current convention — version + opt-in tenant)', () => {
    it('embeds the v1 schema-version segment in the single-tenant prefix', () => {
      expect(CACHE_KEYS.retailOrderPrefix(7)).toBe('ris:retail:order:v1:7:');
      expect(CACHE_KEYS.retailOrder(7)).toBe('ris:retail:order:v1:7:__all__');
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      expect(CACHE_KEYS.retailOrderPrefix(7, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:retail:order:v1:7:',
      );
      expect(CACHE_KEYS.retailOrder(7, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:retail:order:v1:7:__all__',
      );
    });
  });

  describe('catalogProduct (reserved read-path builder — not consumed yet)', () => {
    it('embeds the v1 schema-version segment in the single-tenant prefix', () => {
      expect(CACHE_KEYS.catalogProductPrefix(5001)).toBe('ris:catalog:product:v1:5001:');
      expect(CACHE_KEYS.catalogProduct(5001)).toBe('ris:catalog:product:v1:5001:__all__');
    });

    it('keys on variantId and uses the non-glob __all__ sentinel', () => {
      expect(CACHE_KEYS.catalogProduct(5001)).not.toMatch(/\*/);
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      expect(CACHE_KEYS.catalogProductPrefix(5001, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:product:v1:5001:',
      );
      expect(CACHE_KEYS.catalogProduct(5001, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:product:v1:5001:__all__',
      );
    });
  });

  describe('catalogPrice (reserved pricing read-path builder — not consumed yet)', () => {
    it('embeds the v1 schema-version segment in the single-tenant prefix', () => {
      expect(CACHE_KEYS.catalogPricePrefix(5001)).toBe('ris:catalog:price:v1:5001:');
      expect(CACHE_KEYS.catalogPrice(5001, 'USD')).toBe('ris:catalog:price:v1:5001:USD');
    });

    it('appends the currency as the facet so the prefix wipes every currency', () => {
      const prefix = CACHE_KEYS.catalogPricePrefix(5001);
      expect(CACHE_KEYS.catalogPrice(5001, 'USD').startsWith(prefix)).toBe(true);
      expect(CACHE_KEYS.catalogPrice(5001, 'EUR').startsWith(prefix)).toBe(true);
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      expect(CACHE_KEYS.catalogPricePrefix(5001, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:price:v1:5001:',
      );
      expect(CACHE_KEYS.catalogPrice(5001, 'USD', { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:price:v1:5001:USD',
      );
    });
  });

  describe('catalogCategory (reserved navigation read-path builders — not consumed yet)', () => {
    it('keys the whole tree as a singleton — no `<id>` axis, version terminates the key', () => {
      expect(CACHE_KEYS.catalogCategoryTree()).toBe('ris:catalog:category-tree:v1');
    });

    it('keys the per-category children facet on categoryId with a `children` facet', () => {
      expect(CACHE_KEYS.catalogCategoryChildrenPrefix(7)).toBe('ris:catalog:category:v1:7:');
      expect(CACHE_KEYS.catalogCategoryChildren(7)).toBe('ris:catalog:category:v1:7:children');
    });

    it('keeps the children prefix a prefix of the full key so delByPrefix wipes the facet', () => {
      const prefix = CACHE_KEYS.catalogCategoryChildrenPrefix(7);
      expect(CACHE_KEYS.catalogCategoryChildren(7).startsWith(prefix)).toBe(true);
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      expect(CACHE_KEYS.catalogCategoryTree({ tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:category-tree:v1',
      );
      expect(CACHE_KEYS.catalogCategoryChildrenPrefix(7, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:category:v1:7:',
      );
      expect(CACHE_KEYS.catalogCategoryChildren(7, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:catalog:category:v1:7:children',
      );
    });

    it('omits the tenant segment entirely when no tenantId is supplied', () => {
      expect(CACHE_KEYS.catalogCategoryTree()).not.toMatch(/(^|:)t:/);
      expect(CACHE_KEYS.catalogCategoryChildren(7)).not.toMatch(/(^|:)t:/);
    });
  });

  describe('notificationsConsent (consumed consent read-path builders — ADR-037)', () => {
    it('embeds the v1 schema-version segment and keys on the customer UUID', () => {
      expect(CACHE_KEYS.notificationsConsentPrefix()).toBe('ris:notifications:consent:v1:');
      expect(CACHE_KEYS.notificationsConsent('11111111-1111-4111-8111-111111111111')).toBe(
        'ris:notifications:consent:v1:11111111-1111-4111-8111-111111111111',
      );
    });

    it('keeps the prefix a prefix of the full key so delByPrefix wipes the entry', () => {
      const prefix = CACHE_KEYS.notificationsConsentPrefix();
      expect(CACHE_KEYS.notificationsConsent('cust-1').startsWith(prefix)).toBe(true);
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      expect(CACHE_KEYS.notificationsConsentPrefix({ tenantId: 'store-7' })).toBe(
        'ris:t:store-7:notifications:consent:v1:',
      );
      expect(CACHE_KEYS.notificationsConsent('cust-1', { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:notifications:consent:v1:cust-1',
      );
    });

    it('omits the tenant segment entirely when no tenantId is supplied', () => {
      expect(CACHE_KEYS.notificationsConsent('cust-1')).not.toMatch(/(^|:)t:/);
    });
  });

  describe('productStockPrefix (pre-ADR-016 — RETIRED, no caller)', () => {
    it('is the bare, un-namespaced stock prefix from before ADR-016', () => {
      expect(CACHE_KEYS.productStockPrefix(42)).toBe('stock:42:');
    });
  });
});
