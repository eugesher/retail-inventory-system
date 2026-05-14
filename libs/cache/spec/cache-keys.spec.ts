import { CACHE_KEYS } from '../cache-keys';

// Locks in the audit fixes (CACHE-010, CACHE-011) introduced by the new
// `inventoryStock*` builders. The legacy `productStock*` builders are
// covered too — they MUST keep producing the same key shape during the
// one-deploy transition window described in ADR-016.
describe('CACHE_KEYS', () => {
  describe('inventoryStock (new convention)', () => {
    it('uses the ris:inventory:stock prefix', () => {
      expect(CACHE_KEYS.inventoryStockPrefix(42)).toBe('ris:inventory:stock:42:');
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:42:__all__');
    });

    it('uses the __all__ sentinel (non-glob) when no storageIds are provided', () => {
      // CACHE-011 fix: the literal `*` could be confused with a glob; the
      // new sentinel is unambiguous.
      expect(CACHE_KEYS.inventoryStock(42)).not.toMatch(/\*/);
      expect(CACHE_KEYS.inventoryStock(42)).toBe('ris:inventory:stock:42:__all__');
    });

    it('uses the __all__ sentinel when storageIds is an empty array', () => {
      expect(CACHE_KEYS.inventoryStock(42, [])).toBe('ris:inventory:stock:42:__all__');
    });

    it('joins sorted storageIds with localeCompare', () => {
      // CACHE-010 fix: previously the comparator only inspected charCodeAt(0),
      // so ["ab", "aa"] sorted differently from ["aa", "ab"]. With localeCompare
      // the two inputs collapse to the same key.
      expect(CACHE_KEYS.inventoryStock(1, ['ab', 'aa'])).toBe('ris:inventory:stock:1:aa,ab');
      expect(CACHE_KEYS.inventoryStock(1, ['aa', 'ab'])).toBe('ris:inventory:stock:1:aa,ab');
    });

    it('does not mutate the caller-supplied array', () => {
      const input = ['west', 'east'];
      CACHE_KEYS.inventoryStock(1, input);
      expect(input).toEqual(['west', 'east']);
    });
  });

  describe('retailOrder', () => {
    it('uses the ris:retail:order prefix', () => {
      expect(CACHE_KEYS.retailOrder(7)).toBe('ris:retail:order:7');
      expect(CACHE_KEYS.retailOrderPrefix(7)).toBe('ris:retail:order:7');
    });
  });

  describe('productStock (legacy convention — kept for one-deploy transition)', () => {
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
