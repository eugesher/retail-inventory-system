import { CACHE_KEYS } from '../cache-keys';

// Locks in the production cache-key contract. For the inventory stock aggregate
// four transition layers coexist and each has its own assertion block:
//
//   * Current convention (ADR-022 / ADR-027 `v2`) —
//     `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. For
//     stock the `<id>` axis is the `variantId` and the facet is a sorted
//     stock-location set. Carries the schema-version segment (CACHE-003 fix) and
//     the opt-in tenant segment (CACHE-009 fix) alongside the pre-existing
//     CACHE-010 (localeCompare sort) and CACHE-011 (non-glob `__all__` sentinel) fixes.
//   * Pre-v2 (v1) shape — `ris:inventory:stock:v1:<id>:` — retained as
//     `inventoryStockLegacyPrefixV1` for the rolling-deploy transition window
//     that adopts v2 (ADR-027).
//   * Pre-v1 (post-ADR-016) shape — `ris:<service>:<aggregate>:<id>:` —
//     retained as `inventoryStockLegacyPrefix` for the original v1 transition.
//   * Pre-ADR-016 legacy shape — `stock:<productId>:*` — retained for the
//     original ADR-016 transition window. Must keep producing the same
//     wire format, including the deliberately-preserved `charCodeAt` sort
//     bug.
describe('CACHE_KEYS', () => {
  describe('inventoryStock (current convention — v2, keyed on variantId)', () => {
    it('embeds the v2 schema-version segment in the single-tenant prefix', () => {
      // CACHE-003 fix: a breaking DTO shape change bumps the constant in
      // cache-keys.ts and the pre-bump entries become unreachable on deploy.
      // ADR-027 bumped v1 → v2 when the cached value changed shape (per-product
      // SUM aggregate → per-variant VariantStockView projection).
      expect(CACHE_KEYS.inventoryStockPrefix(42)).toBe('ris:inventory:stock:v2:42:');
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:v2:42:__all__');
    });

    it('omits the tenant segment entirely when no tenantId is supplied', () => {
      // CACHE-009 fix: ADR-022 explicitly rejects a `default` tenant
      // fallback — single-tenant mode means the segment is absent, not
      // silently inherited.
      expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/(^|:)t:/);
      expect(CACHE_KEYS.inventoryStockPrefix(42)).not.toMatch(/(^|:)t:/);
    });

    it('prepends `t:<tenantId>:` immediately after the `ris:` root when tenantId is supplied', () => {
      // Segment order is tenant-near-root so SCAN-by-tenant is a tight
      // prefix wipe (ADR-022 §"Segment order").
      expect(CACHE_KEYS.inventoryStockPrefix(42, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:inventory:stock:v2:42:',
      );
      expect(CACHE_KEYS.inventoryStock(42, undefined, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:inventory:stock:v2:42:__all__',
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
      // CACHE-011 fix: the literal `*` could be confused with a glob; the
      // sentinel is unambiguous.
      expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/\*/);
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:v2:42:__all__');
    });

    it('uses the __all__ sentinel when stockLocationIds is an empty array', () => {
      expect(CACHE_KEYS.inventoryStock(42, [])).toBe('ris:inventory:stock:v2:42:__all__');
    });

    it('joins sorted stockLocationIds with localeCompare', () => {
      // CACHE-010 fix: previously the comparator only inspected charCodeAt(0),
      // so ["ab", "aa"] sorted differently from ["aa", "ab"]. With localeCompare
      // the two inputs collapse to the same key.
      expect(CACHE_KEYS.inventoryStock(1, ['ab', 'aa'])).toBe('ris:inventory:stock:v2:1:aa,ab');
      expect(CACHE_KEYS.inventoryStock(1, ['aa', 'ab'])).toBe('ris:inventory:stock:v2:1:aa,ab');
    });

    it('does not mutate the caller-supplied array', () => {
      const input = ['west', 'east'];
      CACHE_KEYS.inventoryStock(1, input);
      expect(input).toEqual(['west', 'east']);
    });
  });

  describe('inventoryStockLegacyPrefixV1 (pre-v2 — invalidate-only)', () => {
    it('returns the retired v1 shape so the v2 deploy can wipe in-flight v1 entries', () => {
      // The invalidate path uses this to wipe in-flight entries written under
      // the previous v1 shape during the rolling deploy that adopts v2. Reads
      // and writes MUST go through `inventoryStockPrefix` (the v2 builder above).
      expect(CACHE_KEYS.inventoryStockLegacyPrefixV1(42)).toBe('ris:inventory:stock:v1:42:');
    });
  });

  describe('inventoryStockLegacyPrefix (pre-v1 — invalidate-only)', () => {
    it('returns the pre-v1 shape without a version segment', () => {
      // The invalidate path uses this to wipe in-flight entries written
      // under the post-ADR-016 / pre-ADR-022 shape during the rolling
      // deploy. Reads and writes MUST go through `inventoryStockPrefix`
      // (the v2 builder above).
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
    // Locks the reserved catalog read-path key shape (ADR-016 / ADR-022). The
    // builder is keyed on `variantId` (the downstream backbone — ADR-025), not
    // productId. It is **not consumed** by any code path today: the catalog
    // service does not import `CacheModule`. This assertion exists so a future
    // cached catalog read path adopts the locked v1 shape without re-keying.
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
    // Locks the reserved pricing read-path key shape (ADR-016 / ADR-022 /
    // ADR-026). The builder keys on `(variantId, currency)` — the entire price
    // scope. It is **not consumed** by any code path today: the pricing module
    // does not import `CacheModule`. This assertion exists so a future cached
    // Select-Applicable-Price read path adopts the locked v1 shape without
    // re-keying.
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
    // Locks the reserved category navigation key shapes (ADR-016 / ADR-022 /
    // ADR-029). Neither builder is consumed by any code path today: the catalog
    // service does not import `CacheModule`. These assertions exist so a future
    // cached tree/children read path adopts the locked v1 shape without re-keying.
    it('keys the whole tree as a singleton — no `<id>` axis, version terminates the key', () => {
      // The materialized hierarchy is a single value, so there is no per-id
      // segment: the version is the final segment.
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

  describe('productStock (pre-ADR-016 legacy — kept for original transition window)', () => {
    it('uses the bare stock prefix', () => {
      expect(CACHE_KEYS.productStockPrefix(42)).toBe('stock:42:');
      expect(CACHE_KEYS.productStock(42)).toBe('stock:42:*');
    });

    it('joins storageIds via the legacy charCodeAt comparator (preserves wire format)', () => {
      // Legacy bug preserved intentionally: any new code uses inventoryStock.
      expect(CACHE_KEYS.productStock(42, ['head-warehouse'])).toBe('stock:42:head-warehouse');
    });
  });
});
