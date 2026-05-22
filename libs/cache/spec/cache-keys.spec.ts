import { CACHE_KEYS } from '../cache-keys';

// Locks in the production cache-key contract. Three transition layers
// coexist and each has its own assertion block:
//
//   * Current convention (ADR-022) — `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`.
//     Carries the schema-version segment (CACHE-003 fix) and the opt-in
//     tenant segment (CACHE-009 fix) alongside the pre-existing CACHE-010
//     (localeCompare sort) and CACHE-011 (non-glob `__all__` sentinel) fixes.
//   * Pre-v1 (post-ADR-016) shape — `ris:<service>:<aggregate>:<id>:` —
//     retained as `inventoryStockLegacyPrefix` for the rolling-deploy
//     transition window described in ADR-022.
//   * Pre-ADR-016 legacy shape — `stock:<productId>:*` — retained for the
//     original ADR-016 transition window. Must keep producing the same
//     wire format, including the deliberately-preserved `charCodeAt` sort
//     bug.
describe('CACHE_KEYS', () => {
  describe('inventoryStock (current convention — version + opt-in tenant)', () => {
    it('embeds the v1 schema-version segment in the single-tenant prefix', () => {
      // CACHE-003 fix: any breaking DTO shape change bumps the constant in
      // cache-keys.ts and the pre-bump entries become unreachable on deploy.
      expect(CACHE_KEYS.inventoryStockPrefix(42)).toBe('ris:inventory:stock:v1:42:');
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:v1:42:__all__');
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
        'ris:t:store-7:inventory:stock:v1:42:',
      );
      expect(CACHE_KEYS.inventoryStock(42, undefined, { tenantId: 'store-7' })).toBe(
        'ris:t:store-7:inventory:stock:v1:42:__all__',
      );
    });

    it('keeps the prefix and full key consistent so delByPrefix wipes every facet', () => {
      const productId = 42;
      const tenantId = 'store-7';

      const singleTenantPrefix = CACHE_KEYS.inventoryStockPrefix(productId);
      expect(CACHE_KEYS.inventoryStock(productId).startsWith(singleTenantPrefix)).toBe(true);
      expect(
        CACHE_KEYS.inventoryStock(productId, ['head-warehouse']).startsWith(singleTenantPrefix),
      ).toBe(true);

      const tenantPrefix = CACHE_KEYS.inventoryStockPrefix(productId, { tenantId });
      expect(
        CACHE_KEYS.inventoryStock(productId, undefined, { tenantId }).startsWith(tenantPrefix),
      ).toBe(true);
      expect(
        CACHE_KEYS.inventoryStock(productId, ['head-warehouse'], { tenantId }).startsWith(
          tenantPrefix,
        ),
      ).toBe(true);
    });

    it('uses the __all__ sentinel (non-glob) when no storageIds are provided', () => {
      // CACHE-011 fix: the literal `*` could be confused with a glob; the
      // sentinel is unambiguous.
      expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/\*/);
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:v1:42:__all__');
    });

    it('uses the __all__ sentinel when storageIds is an empty array', () => {
      expect(CACHE_KEYS.inventoryStock(42, [])).toBe('ris:inventory:stock:v1:42:__all__');
    });

    it('joins sorted storageIds with localeCompare', () => {
      // CACHE-010 fix: previously the comparator only inspected charCodeAt(0),
      // so ["ab", "aa"] sorted differently from ["aa", "ab"]. With localeCompare
      // the two inputs collapse to the same key.
      expect(CACHE_KEYS.inventoryStock(1, ['ab', 'aa'])).toBe('ris:inventory:stock:v1:1:aa,ab');
      expect(CACHE_KEYS.inventoryStock(1, ['aa', 'ab'])).toBe('ris:inventory:stock:v1:1:aa,ab');
    });

    it('does not mutate the caller-supplied array', () => {
      const input = ['west', 'east'];
      CACHE_KEYS.inventoryStock(1, input);
      expect(input).toEqual(['west', 'east']);
    });
  });

  describe('inventoryStockLegacyPrefix (pre-v1 — invalidate-only)', () => {
    it('returns the pre-v1 shape without a version segment', () => {
      // The invalidate path uses this to wipe in-flight entries written
      // under the post-ADR-016 / pre-ADR-022 shape during the rolling
      // deploy. Reads and writes MUST go through `inventoryStockPrefix`
      // (the v1 builder above).
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
