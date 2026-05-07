// FOLLOW-UP (AR3): cache values are typed at compile time only. If
// ProductStockGetResponseDto's shape changes, in-flight cache entries from the
// old shape will deserialize without runtime validation and may surface as
// silently-wrong responses for one TTL window. Mitigation: include a schema
// version segment in the key (e.g. `stock:v2:<productId>:...`) and bump it on
// breaking shape changes. Not applied today; recorded for a future pass.
export class CacheHelper {
  public static ttlValues = {
    productStock: 60_000,
  };

  public static keyPrefixes = {
    // RISK FLAG #2: tenant collision.
    // Cache keys are namespaced only by productId. There is no tenant/store
    // segment, so once a multi-tenant model is introduced two tenants holding
    // the same productId will read each other's cached stock — a correctness
    // and data-leak bug. To fix, prepend the tenant identifier (e.g.
    // `t:<tenantId>:stock:<productId>:`). No tenant model exists today, so
    // this is latent. Left unfixed by request.
    productStock: (productId: number): string => `stock:${productId}:`,
  };

  public static keys = {
    productStock: (productId: number, storageIds?: string[]): string => {
      const prefix = CacheHelper.keyPrefixes.productStock(productId);
      // RISK FLAG #3: cache key sort bug.
      // The sort comparator uses only the FIRST character's char code
      // (`a.charCodeAt(0) - b.charCodeAt(0)`). For any pair of storage IDs
      // sharing a first character (e.g. `["ab", "aa"]`) the comparator
      // returns 0, so the resulting order depends on the input order — and
      // the cache key ends up input-order-dependent too. The consequence is
      // extra cache misses (not wrong data), because callers that pass the
      // same set of storage IDs in different orders generate different keys.
      // To fix, use a full lexicographic compare: `a.localeCompare(b)`.
      // Left unfixed by request.
      const storageKey = storageIds
        ? [...storageIds].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0)).join(',')
        : '*';

      return `${prefix}${storageKey}`;
    },
  };
}
