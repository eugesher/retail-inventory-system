export class CacheKeys {
  public static productStock(productId: number, storageIds?: number[]): string {
    const storageKey = storageIds ? [...storageIds].sort((a, b) => a - b).join(',') : '*';

    return `stock:${productId}:${storageKey}`;
  }

  /**
   * Returns a prefix pattern for invalidating all cache entries
   * related to a specific product's stock, regardless of storage filter.
   */
  public static productStockPrefix(productId: number): string {
    return `stock:${productId}:`;
  }
}
